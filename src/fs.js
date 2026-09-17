import { conform } from "./contract.js"
import { loader } from "./loader.js"
import { copyTree, matches, find as findFirst, walk } from "./tree.js"

/**
 * THE FILE DOOR — every verb a host had to write over the byte driver.
 *
 * ── Why the whole door, and not six more verbs ──────────────────────────────
 *
 * This package shipped the bytes (ten driver verbs, two realms, a conformance kit
 * for the six beyond the four it uses itself) and then left the DOOR to every
 * host. Measured in akao, 2026-09-17: 523 lines across 17 files, of which the
 * overwhelming majority is either a rename of a driver verb, a translation of a
 * throw into `false`, a traversal that needs two verbs at once, or the tier
 * ladder whose law was already written here. One capability, a home in each
 * repository — the same finding that moved IDB, OPFS, the SQL queue and the byte
 * layer itself, arriving last at the door that sits on top of all of them.
 *
 * So: the door is this package's. What stays a PARAMETER is every answer that
 * belongs to a host and to no law here — the two kinds this package refuses to
 * own, because it paid for owning one before (`statics.js`, the `.hash` address):
 *
 *   a SPELLING     `origin`/`urlOf` — where a path is published, and what a path
 *                  looks like as a string on this platform.
 *   a VOCABULARY   `parse`/`stringify` — which extensions mean YAML, CSV, or
 *                  something only this host has. The defaults are JSON and text,
 *                  which is what "no vocabulary of my own" means.
 *   a SOURCE       `tier` — one more place to look below the store.
 *
 * ── The ergonomics, and the bill that decided them ──────────────────────────
 *
 * A QUESTION answers: `exists`, `isDir`, `list`, `load`, `find` never throw, and
 * an absent path is an ordinary answer rather than an incident.
 *
 * A COMMAND THROWS. `write`, `remove`, `move`, `ensure`, `copy`, `download` fail
 * loudly, wrapped ONCE, naming the verb and the path.
 *
 * The first draft of this file did the opposite — reported and answered `false` —
 * on the reasoning that a caller should not have to wrap every write in a
 * try/catch. akao had already paid for that reasoning twice, and the bills are
 * why this paragraph exists rather than the other one:
 *
 *   the build step that could not fail   `FS.copy` used to console.error and
 *   (akao #858)                          answer undefined, so every vendor copy
 *                                        in the build became a step incapable of
 *                                        failing. A package that moved one of its
 *                                        files printed one red line into a
 *                                        thousand-line log and exited 0 — and the
 *                                        page 404'd that module at the moment it
 *                                        was first needed, which is neither build
 *                                        time nor test time.
 *   a bug reported as a fact about the   `remove()` caught a TypeError from a
 *   disk (akao's FS/driver.js)           malformed path and answered `false`,
 *                                        while its own docblock defined `false` as
 *                                        "the path is still there". A defect in
 *                                        the caller, dressed as news about the
 *                                        filesystem.
 *
 * So the optional case is a GUARD at the call site — ask `exists` first — never a
 * silence inside the door. That is one line where the caller knows it is optional,
 * against a whole class of failures that cannot surface anywhere else.
 *
 * This is the same posture `conform()` takes for a wiring, and for a reason that
 * turns out to be one reason: both are cases where the only alternative to
 * refusing is a program that keeps running while being wrong.
 */
export function fs(wiring = {}) {
    conform("fs()", wiring)
    const { driver, origin = null, urlOf = null, parse, stringify = stringifyDefault, tier = null, fetch: fetcher } = wiring

    // A path is published wherever the host says. With an `origin` and no
    // `urlOf`, "published" means the obvious thing and the host does not have to
    // write it; a host whose URLs are not its paths passes `urlOf` instead.
    const where = urlOf ?? (origin ? (path) => `${origin}/${path.join("/")}` : () => null)
    const load = loader({ driver, urlOf: where, parse, tier, fetch: fetcher })

    /**
     * Wrap ONCE, at the leaf, naming the verb and the path.
     *
     * Once, because a recursive verb that wraps at every level produces a message
     * whose prefix is repeated as many times as the tree was deep, and the reader
     * then cannot see which level actually failed. The marker is how a re-wrap is
     * recognised.
     */
    const MARK = "[FS]"
    const loudly = async (verb, path, body) => {
        try {
            return await body()
        } catch (error) {
            const message = String(error?.message ?? error)
            if (message.includes(MARK)) throw error
            throw new Error(`${MARK} ${verb} failed at ${Array.isArray(path) ? path.join("/") : path}: ${message}`, { cause: error })
        }
    }

    return {
        // The store itself, so a caller that needs bytes is not forced through a
        // door that parses them.
        driver,
        /**
         * WHICH store this door reads — asked THROUGH the driver, never snapshotted.
         *
         * It was a snapshot for one commit, and that is the akao #858 defect in
         * miniature: a host's store can MOVE under a door (a suite stages another
         * tree, a worker inherits a root, a fork run points at one site's build), and
         * a driver that answers `scope` through a getter is telling the truth while a
         * door that copied it once is not. Measured with a probe: after the store
         * moved, `driver.scope` said the new root and `door.scope` still said the old
         * one. A mark can be forgotten; a question cannot.
         */
        get scope() {
            return driver.scope
        },

        // ── Questions ───────────────────────────────────────────────────────
        load,
        exists: (path) => driver.exists(path),
        isDir: (path) => driver.isDir(path),
        list: (path) => driver.list(path),
        entries: (path) => driver.entries(path),
        walk: (path, visitor) => walk(driver, path, visitor),
        find: (paths) => findFirst(driver, paths),
        /** Every file under `path`, or those whose RELATIVE path matches a pattern. */
        dir: (path, pattern = null) => (pattern ? matches(driver, path, pattern) : driver.list(path)),

        // ── Commands ────────────────────────────────────────────────────────
        /**
         * Write a document, serialised by the host's vocabulary; bytes pass straight
         * through. Refuses an object bound for a path with no extension, because
         * that is the shape that silently writes "[object Object]" to disk.
         */
        write: (path, content) =>
            loudly("write", path, async () => {
                // Nothing to write is not a failure and not a write: a caller
                // building a document conditionally passes undefined on purpose.
                if (content === undefined || content === null) return false
                if (content instanceof Uint8Array) {
                    await driver.writeBytes(path, content)
                    return true
                }
                const name = path.at(-1)
                // The shape that silently puts "[object Object]" on a disk and is
                // found weeks later by whoever reads it back.
                if (typeof content === "object" && !String(name).includes(".")) throw new Error(`an object needs an extension to be serialised by — "${name}" has none`)
                await driver.writeBytes(path, stringify(content, name))
                return true
            }),
        remove: (path) => loudly("remove", path, async () => (await driver.remove(path), true)),
        move: (from, to) => loudly("move", from, async () => (await driver.move(from, to), true)),
        ensure: (path) => loudly("ensure", path, async () => (await driver.mkdir(path), true)),
        /** Copy a file or a whole subtree, and say what happened. */
        copy: (from, to, options = {}) => loudly("copy", from, () => copyTree(driver, from, to, options)),
        /**
         * Fetch a URL into the store. The name comes from the path when it carries
         * one, and from the URL when it does not — a caller that passes a directory
         * should not have to repeat what the server already said the file is called.
         */
        download: (url, path = []) =>
            loudly("download", url, async () => {
                const parsed = new URL(url) // a bad URL is the caller's bug, and it says so
                const last = path.at(-1)
                const target = String(last ?? "").includes(".") ? path : [...path, parsed.pathname.split("/").filter(Boolean).pop() || "download"]
                const response = await (fetcher ?? globalThis.fetch)(url)
                // Never write a non-2xx body: an error page under the name of the
                // asset is the worst of the three outcomes, because every later
                // read succeeds.
                if (!response.ok) throw new Error(`${url} answered ${response.status}`)
                await driver.writeBytes(target, new Uint8Array(await response.arrayBuffer()))
                return target
            })
    }
}

/** JSON indented, or the text itself — what "no vocabulary of my own" means. */
function stringifyDefault(content, name) {
    if (typeof content === "string") return new TextEncoder().encode(content)
    if (String(name).endsWith(".json")) return new TextEncoder().encode(`${JSON.stringify(content, null, 4)}\n`)
    return new TextEncoder().encode(String(content))
}
