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
 * ── The ergonomics, stated once because they are a choice ───────────────────
 *
 * A QUESTION answers: `exists`, `isDir`, `list`, `load`, `find` never throw, and
 * an absent path is an ordinary answer rather than an incident. A COMMAND reports
 * and answers whether it happened: `write`, `remove`, `move`, `ensure`, `copy`
 * log the failure with the path in it and answer `false`, because a caller that
 * has to wrap every write in a try/catch writes the same five lines everywhere
 * and eventually writes an empty catch instead.
 *
 * This is not the same posture as `conform()`, which refuses a WIRING by name and
 * loudly. The difference is the moment: a wiring mistake is a programming error
 * discovered once, at boot, and must stop the program; a write that failed is a
 * fact about a disk, at any time, and the program is supposed to survive knowing
 * it.
 */
export function fs(wiring = {}) {
    conform("fs()", wiring)
    const { driver, origin = null, urlOf = null, parse, stringify = stringifyDefault, tier = null, fetch: fetcher } = wiring

    // A path is published wherever the host says. With an `origin` and no
    // `urlOf`, "published" means the obvious thing and the host does not have to
    // write it; a host whose URLs are not its paths passes `urlOf` instead.
    const where = urlOf ?? (origin ? (path) => `${origin}/${path.join("/")}` : () => null)
    const load = loader({ driver, urlOf: where, parse, tier, fetch: fetcher })

    const failed = (verb, path, error) => {
        console.error(`FS.${verb} failed at ${Array.isArray(path) ? path.join("/") : path}:`, error?.message ?? error)
        return false
    }

    return {
        // The store itself, so a caller that needs bytes is not forced through a
        // door that parses them.
        driver,
        scope: driver.scope,

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
        write: async (path, content) => {
            if (content === undefined || content === null) return false
            try {
                if (content instanceof Uint8Array) {
                    await driver.writeBytes(path, content)
                    return true
                }
                const name = path.at(-1)
                if (typeof content === "object" && !String(name).includes(".")) return failed("write", path, new Error(`an object needs an extension to be serialised by — "${name}" has none`))
                await driver.writeBytes(path, stringify(content, name))
                return true
            } catch (error) {
                return failed("write", path, error)
            }
        },
        remove: async (path) => {
            try {
                await driver.remove(path)
                return true
            } catch (error) {
                return failed("remove", path, error)
            }
        },
        move: async (from, to) => {
            try {
                await driver.move(from, to)
                return true
            } catch (error) {
                return failed("move", from, error)
            }
        },
        ensure: async (path) => {
            try {
                await driver.mkdir(path)
                return true
            } catch (error) {
                return failed("ensure", path, error)
            }
        },
        /** Copy a file or a whole subtree; answers what happened, or false. */
        copy: async (from, to, options = {}) => {
            try {
                return await copyTree(driver, from, to, options)
            } catch (error) {
                return failed("copy", from, error)
            }
        },
        /**
         * Fetch a URL into the store. The name comes from the path when it carries
         * one, and from the URL when it does not — a caller that passes a directory
         * should not have to repeat what the server already said the file is called.
         */
        download: async (url, path = []) => {
            let parsed
            try {
                parsed = new URL(url)
            } catch {
                return failed("download", url, new Error("not a URL"))
            }
            const last = path.at(-1)
            const target = String(last ?? "").includes(".") ? path : [...path, parsed.pathname.split("/").filter(Boolean).pop() || "download"]
            try {
                const response = await (fetcher ?? globalThis.fetch)(url)
                if (!response.ok) return failed("download", target, new Error(`the origin answered ${response.status}`))
                await driver.writeBytes(target, new Uint8Array(await response.arrayBuffer()))
                return target
            } catch (error) {
                return failed("download", target, error)
            }
        }
    }
}

/** JSON indented, or the text itself — what "no vocabulary of my own" means. */
function stringifyDefault(content, name) {
    if (typeof content === "string") return new TextEncoder().encode(content)
    if (String(name).endsWith(".json")) return new TextEncoder().encode(`${JSON.stringify(content, null, 4)}\n`)
    return new TextEncoder().encode(String(content))
}
