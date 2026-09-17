import { readFile, writeFile, mkdir, rm, readdir, stat, rename, copyFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

/**
 * The byte driver for a Node realm: one directory tree, four verbs.
 *
 * ── Why the package ships one ──────────────────────────────────────────────
 *
 * `driver` is a port, and a port means a host MAY supply its own. Most hosts
 * have nothing to supply: they want documents in a directory, and writing
 * readBytes/writeBytes/remove/entries against node:fs is work every one of them
 * would do identically. This package had already written it — in `test/real.js`,
 * as a test helper — which is the clearest possible evidence that it belongs
 * here: the implementation existed, and every user still had to type it again.
 *
 * A host with a file layer of its own (akao has a ten-verb file door) keeps
 * injecting that instead. The port is unchanged; what changes is that having one
 * is no longer a precondition for using this package.
 *
 * ── The meanings, which `conformance.js` pins ─────────────────────────────
 *
 * They are not free choices, they are what the engines above expect:
 *
 *   readBytes  → the bytes, or NULL when there is nothing there. Absence is an
 *                answer, not an exception: the statics engine asks "is there an
 *                at-rest copy" on every read, and a throw would make a normal
 *                miss look like a fault.
 *   writeBytes → creates the parents. A caller writing `a/b/c.json` is stating
 *                where the file goes, not promising the directories exist.
 *   remove     → recursive, and removing what is not there SUCCEEDS. The caller
 *                asked for it to be gone; it is gone.
 *   entries    → `{ name, isDir }`, and a directory that does not exist answers
 *                `[]`. Walking is a statement about what IS there (see walk.js).
 *   scope      → which store this is. Two drivers with the same scope claim to
 *                be the same store, and caches inside this package believe them.
 */
export function nodeDriver({ root = "." } = {}) {
    const base = resolve(root)
    const at = (path) => join(base, ...path)
    return {
        scope: base,
        readBytes: async (path) => {
            try {
                return new Uint8Array(await readFile(at(path)))
            } catch (error) {
                if (error?.code === "ENOENT" || error?.code === "EISDIR") return null
                throw error
            }
        },
        writeBytes: async (path, bytes) => {
            const file = at(path)
            await mkdir(dirname(file), { recursive: true })
            await writeFile(file, bytes)
        },
        remove: async (path) => {
            await rm(at(path), { recursive: true, force: true })
        },
        entries: async (path) => {
            try {
                return (await readdir(at(path), { withFileTypes: true })).map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
            } catch (error) {
                if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return []
                throw error
            }
        },
        // ── The file-door verbs ────────────────────────────────────────────
        // Four verbs are what THIS package calls; these six are what a host with
        // a file layer of its own needs, and every one of them was being written
        // again by that host over the same backend. The port still demands four
        // (src/contract.js) — a package may ship more than it asks for, and
        // asking for ten would impose a law this package does not live by.
        list: async (path) => (await readdir(at(path)).catch(() => [])).slice(),
        exists: async (path) => {
            try {
                await stat(at(path))
                return true
            } catch {
                return false
            }
        },
        isDir: async (path) => {
            try {
                return (await stat(at(path))).isDirectory()
            } catch {
                return false
            }
        },
        mkdir: async (path) => {
            await mkdir(at(path), { recursive: true })
        },
        move: async (from, to) => {
            await mkdir(dirname(at(to)), { recursive: true })
            await rename(at(from), at(to))
        },
        copyFile: async (from, to) => {
            await mkdir(dirname(at(to)), { recursive: true })
            await copyFile(at(from), at(to))
        }
    }
}

export default nodeDriver
