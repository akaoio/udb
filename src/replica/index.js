import { spawn, spawnSync } from "node:child_process"
import { readdirSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { REPLICATED_PRAGMAS, BUSY_MS } from "./pragmas.js"
import { conform } from "../contract.js"

/**
 * Continuous replication of a DIRECTORY of SQLite databases, with Litestream.
 *
 * ── The capability, and why the directory is the unit ──────────────────────
 *
 * "These databases survive the machine." Litestream tails each database's WAL
 * and ships it to object storage, so the loss window is one sync rather than one
 * backup cycle. The awkward part — and the reason this module exists rather than
 * a line of shell — is that **Litestream has no glob**: a config naming
 * `data/*.db` makes it replicate one database literally called `*.db` (measured,
 * 0.5.16). A directory that grows a file on demand therefore needs its config
 * GENERATED from the directory and REGENERATED when the set changes, and
 * Litestream does not reload config, so that means restarting it.
 *
 * That is the whole of what this package knows. Everything that names one
 * deployment — which bucket, which credentials, where the binary was installed,
 * what the log lines should look like — arrives as a PARAMETER. A capability has
 * one owner and the host reaches it through the seam (see `src/contract.js`);
 * this file is what that law looks like when it is applied to replication.
 *
 * ── Why `replicas` is a FUNCTION, not a table of backends ──────────────────
 *
 * Litestream's own config understands s3, gcs, abs, sftp, file — and will
 * understand more. Modelling that taxonomy here would date this file to the
 * version it was written against, and would make every new backend a change in
 * THIS package rather than in the host that wants it. So the host answers one
 * question instead: **given a database id, where does it replicate to?** The
 * answer is a list of plain Litestream replica entries, and this module places
 * them under each database. Any backend Litestream supports works, today and
 * later, with nothing here to update.
 *
 * Per-database destinations are not a nicety: two databases shipping to one
 * prefix overwrite each other's generations, and the failure surfaces only when
 * somebody restores.
 *
 * ── Robustness: what it refuses, and what it must never do ─────────────────
 *
 * A backup that has been failing quietly for a week is worse than no backup,
 * because it was believed. So: a missing binary, a `replicas` that answers with
 * nothing, and a value this module cannot write into a config are REFUSED BY
 * NAME. And the one thing it must never do is take the host process down with
 * it — an unhandled `error` on a spawned child is an uncaught exception, so
 * every child event is handled and a replicator that cannot run turns itself off
 * loudly instead.
 */

/** Litestream's own config file name, written inside the directory it replicates. */
export const CONFIG_NAME = "litestream.yml"

/** How often the directory is re-read for databases that appeared or vanished. */
export const SCAN_MS = 30000

export { REPLICATED_PRAGMAS, BUSY_MS }

/**
 * The Litestream binary this machine can actually run, or `null`.
 *
 * Asked BEFORE anything is spawned, because a backup that cannot start must turn
 * itself off loudly rather than take the host down: having credentials says
 * nothing about the binary being installed, and on a developer's machine it
 * usually is not.
 *
 * An operator who NAMES a binary means that one — falling back quietly to
 * another is how a machine ends up replicating with a version nobody chose.
 * `candidates` is where a host offers its own vendored copy; the bare name on
 * PATH is tried last.
 */
export function resolveBinary(candidate = null, { candidates = [], name = "litestream" } = {}) {
    const runs = (path) => {
        try {
            const probe = spawnSync(path, ["version"], { encoding: "utf8" })
            return !probe.error && probe.status === 0
        } catch {
            return false
        }
    }
    if (candidate) return runs(candidate) ? candidate : null
    for (const vendored of candidates) if (existsSync(vendored) && runs(resolve(vendored))) return resolve(vendored)
    return runs(name) ? name : null
}

/** The databases in `dir`, sorted — a replicator's own sidecars and WAL files are not databases. */
export function databasesIn(dir) {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
        .filter((name) => name.endsWith(".db") && !name.startsWith("."))
        .sort()
}

/** The id a database file is known by — the file name without its extension. */
export const idOf = (name) => name.replace(/\.db$/, "")

/**
 * One YAML scalar. Strings are quoted only when leaving them bare would change
 * what the value IS — a path with a colon in it, a leading space, an empty
 * string. Readable configs are part of this being operable: people paste them
 * into issues.
 */
function scalar(value, where) {
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (typeof value !== "string") throw new Error(`replica: ${where} must be a string, number or boolean — a Litestream replica entry is flat key/value, and this module will not guess how to write a ${Array.isArray(value) ? "list" : typeof value}`)
    if (value === "" || /^[\s>|*&!%@`"'#-]|[:#]\s|\s$/.test(value)) return JSON.stringify(value)
    return value
}

/**
 * The Litestream config for a set of databases.
 *
 * Credentials never appear: Litestream reads them from the environment, and a
 * config file is a thing people paste into issues. This module writes no secret
 * even if a host hands one over — a `replicas` entry naming a credential key is
 * refused rather than written.
 */
export function configFor(dir, names, replicas) {
    if (typeof replicas !== "function") throw new Error("replica: configFor needs `replicas(id)` — a function answering where a database of this directory ships to (the host decides the backend; this package only places it)")
    const base = resolve(dir)
    // `dbs` and `replicas` are keys of Litestream's config format, not names this
    // package chose, so they are not this package's to spell differently.
    const lines = [`# GENERATED for ${base} — edits are overwritten on the next scan`, "dbs:"]
    for (const name of names) {
        const id = idOf(name)
        const targets = replicas(id)
        if (!Array.isArray(targets) || !targets.length) throw new Error(`replica: replicas(${JSON.stringify(id)}) answered with ${Array.isArray(targets) ? "an empty list" : typeof targets} — a database with no destination would be believed to be backed up and would not be`)
        lines.push(`  - path: ${scalar(join(base, name), `the path of ${name}`)}`)
        lines.push("    replicas:")
        for (const target of targets) {
            if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error(`replica: replicas(${JSON.stringify(id)}) must answer with Litestream replica objects — got ${Array.isArray(target) ? "a list" : target === null ? "null" : typeof target}`)
            const keys = Object.keys(target)
            if (!keys.length) throw new Error(`replica: replicas(${JSON.stringify(id)}) answered with an empty object — Litestream needs at least a type or a url`)
            for (const key of keys) {
                if (SECRET.test(key)) throw new Error(`replica: replicas(${JSON.stringify(id)}) carries "${key}" — credentials belong in the environment Litestream reads, never in a config file, which is a thing people paste into issues`)
            }
            lines.push(`      - ${keys.map((key, index) => `${index ? "        " : ""}${key}: ${scalar(target[key], `${key} of ${id}`)}`).join("\n")}`)
        }
    }
    return lines.join("\n") + "\n"
}

/** Keys a config must never carry, whatever a host believes. */
const SECRET = /secret|password|access[-_]?key|token|credential/i

export class Replica {
    /**
     * @param {object} options
     * @param {string} options.name — what this set of databases is CALLED. It is
     *   the word every log line carries, so two replicas in one process are told
     *   apart by an operator reading them.
     * @param {string} options.dir — the directory whose `*.db` files are shipped.
     * @param {(id: string) => object[]} options.replicas — where a database ships
     *   to, by id. See the header: this is the seam, not a backend table.
     * @param {string|null} [options.binary] — the Litestream binary. `null` asks
     *   `resolveBinary` to find one; `candidates` is where a host offers its own.
     * @param {string[]} [options.candidates] — paths to try before PATH.
     * @param {number} [options.scanMs] — how often the directory is re-read.
     * @param {{log: Function, warn: Function}} [options.log] — where this speaks.
     *   A host with its own logger passes it rather than having this package
     *   write into a stream it does not own.
     */
    constructor({ name, dir, replicas, binary = null, candidates = [], scanMs = SCAN_MS, log = console } = {}) {
        if (!name) throw new Error("replica: a replica needs a NAME — it is what every log line about it carries, and what tells two of them apart in one process")
        if (!dir) throw new Error(`replica ${name}: a replica needs a directory — the set of databases in it is READ FROM DISK, never from a list, because Litestream has no glob`)
        // The port, checked the way every other port is: at wiring, by name,
        // against the one registry (src/contract.js).
        conform("replica()", { replicas })
        this.name = name
        this.$dir = dir
        this.$replicas = replicas
        this.$binary = binary
        this.$candidates = candidates
        this.$scanMs = scanMs
        this.$log = log
        this.$child = null
        this.$timer = null
        this.$names = []
        this.$closed = false
    }

    /** Whether a binary this machine can run was found. Says nothing about a destination. */
    get enabled() {
        return Boolean(resolveBinary(this.$binary, { candidates: this.$candidates }))
    }

    get configPath() {
        return join(this.$dir, CONFIG_NAME)
    }

    /** The databases currently being replicated — the honest answer, not the intent. */
    get replicating() {
        return [...this.$names]
    }

    /**
     * Begin. A machine with no binary says so and stays off; it never throws,
     * because a host that cannot back up must still run.
     */
    start() {
        const binary = resolveBinary(this.$binary, { candidates: this.$candidates })
        if (!binary) {
            this.$log.warn?.(`${this.name} replica: ${this.$binary ? `${this.$binary} does not run` : "no litestream binary found"} — replication is OFF`)
            return this
        }
        this.$binary = binary
        this.$sync()
        this.$timer = setInterval(() => this.$sync(), this.$scanMs)
        this.$timer.unref?.()
        return this
    }

    /** Rewrite the config and restart Litestream — but only when the set actually changed. */
    $sync() {
        if (this.$closed) return
        const names = databasesIn(this.$dir)
        const changed = names.length !== this.$names.length || names.some((name, index) => name !== this.$names[index])
        if (!changed && this.$child && this.$child.exitCode === null) return

        const added = names.filter((name) => !this.$names.includes(name))
        const dropped = this.$names.filter((name) => !names.includes(name))
        this.$names = names
        writeFileSync(this.configPath, configFor(this.$dir, names, this.$replicas))
        this.#restart()
        // Say it out loud. A database silently outside the backup set is exactly
        // the kind of thing nobody notices until the disk is gone.
        if (added.length) this.$log.log?.(`${this.name} replica: now backing up ${added.join(", ")}`)
        if (dropped.length) this.$log.log?.(`${this.name} replica: no longer backing up ${dropped.join(", ")}`)
    }

    #restart() {
        this.#stopChild()
        if (!this.$names.length) return
        this.$child = spawn(this.$binary, ["replicate", "-config", this.configPath], { stdio: ["ignore", "pipe", "pipe"], env: process.env })
        this.$child.stdout.on("data", () => {}) // drained on purpose: Litestream is chatty at INFO
        this.$child.stderr.on("data", (chunk) => {
            const text = String(chunk)
            // Only the parts an operator must act on.
            if (/level=(ERROR|WARN)/.test(text)) this.$log.warn?.(`${this.name} replica:`, text.trim().split("\n")[0])
        })
        // A binary that vanishes mid-run must not take the host with it: an
        // unhandled ChildProcess "error" is an uncaught exception.
        this.$child.on("error", (error) => {
            this.$log.warn?.(`${this.name} replica: cannot run litestream (${error.code ?? error.message}) — replication is NOT running`)
            this.$child = null
        })
        this.$child.on("exit", (code) => {
            if (this.$closed || code === 0 || code === null) return
            this.$log.warn?.(`${this.name} replica: litestream exited with ${code} — replication is NOT running`)
        })
        this.$log.log?.(`${this.name} replica: ${this.$names.length} database(s) under continuous replication`)
    }

    #stopChild() {
        if (!this.$child) return
        const child = this.$child
        this.$child = null
        try {
            child.kill("SIGTERM")
        } catch {
            /* already gone */
        }
    }

    close() {
        this.$closed = true
        clearInterval(this.$timer)
        this.#stopChild()
    }
}

/** The usual way in: build one and start it. */
export function replica(options) {
    return new Replica(options).start()
}

export default Replica
