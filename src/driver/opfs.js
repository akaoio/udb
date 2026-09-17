/**
 * The byte driver for a browser realm: the Origin Private File System.
 *
 * ── Why the package ships one ──────────────────────────────────────────────
 *
 * Same reason as the Node one, plus a detail no host should have to rediscover:
 * **two writes to one path at the same time throw `NoModificationAllowedError`**.
 * OPFS hands out one writable per file and a second `createWritable()` while the
 * first is open fails — so a driver without a per-path queue works in every test
 * and breaks the day two writes race, which is the day the app gets busy. The
 * queue below is that, and it is the kind of thing a package exists to carry.
 *
 * ── Why the root is a parameter ────────────────────────────────────────────
 *
 * `navigator.storage.getDirectory()` is the default and the normal case, but
 * taking the handle lets a host mount a subtree — and lets this package TEST the
 * driver: the tests hand it a plain in-memory implementation of the handle
 * methods used here, so the queue, the create flags and the error mapping are
 * measured without a browser. A browser is still where OPFS is real, and the
 * host's own suite is where that is proven; what is proven here is the logic.
 *
 * ── What OPFS does not have ────────────────────────────────────────────────
 *
 * No `stat` and no `rename`. `isDir` is answered by TRYING to open the name as a
 * directory, `exists` by looking for the name among its parent's keys, and
 * `move` is a copy followed by a remove. Each is what the platform gives, and
 * writing them once here is the point — a host doing it again gets to
 * rediscover that `getDirectoryHandle` on a file THROWS `TypeMismatchError`
 * rather than answering false.
 */
import { pathOf } from "./path.js"

/**
 * Does this realm HAVE an Origin Private File System?
 *
 * One home for the predicate, because two answers to it disagree the day the
 * platform changes shape: `driver()` picks the realm by asking exactly this, and
 * a host must be able to ask the same question when it has to survive the answer
 * being no (a degraded read tier rather than a dead page). akao had its own copy
 * of this line — nine lines of a file, and the same `typeof
 * navigator?.storage?.getDirectory === "function"` (measured 2026-09-17).
 *
 * `scope` is a parameter for the same reason `detectEnvironment`'s is: it is the
 * only way either branch is testable.
 */
export function supportsOPFS(scope = globalThis) {
    return typeof scope?.navigator?.storage?.getDirectory === "function"
}

const NOT_FOUND = new Set(["NotFoundError", "TypeMismatchError"])

/** The directory handle for a path, optionally creating it on the way down. */
async function directoryOf(root, path, create) {
    let handle = root
    for (const segment of pathOf(path, "opfsDriver")) handle = await handle.getDirectoryHandle(segment, { create })
    return handle
}

async function fileOf(base, path, create) {
    pathOf(path, "opfsDriver")
    const directory = await directoryOf(await base(), path.slice(0, -1), create)
    return directory.getFileHandle(path.at(-1), { create })
}

async function readThrough(base, path) {
    try {
        const handle = await fileOf(base, path, false)
        const file = await handle.getFile()
        return new Uint8Array(await file.arrayBuffer())
    } catch (error) {
        if (NOT_FOUND.has(error?.name)) return null
        throw error
    }
}

/**
 * One writable per file at a time, or `NoModificationAllowedError`.
 *
 * The stored promise is silenced so a failed write does not poison the next one
 * in the queue, and the entry is dropped when it is the last in the chain so the
 * map cannot grow forever.
 */
function writeThrough(base, locks, path, bytes) {
    const key = path.join("/")
    const previous = locks.get(key) ?? Promise.resolve()
    const task = previous.then(async () => {
        const handle = await fileOf(base, path, true)
        const writable = await handle.createWritable()
        await writable.write(bytes)
        await writable.close()
    })
    const queued = task.catch(() => {})
    locks.set(key, queued)
    queued.finally(() => {
        if (locks.get(key) === queued) locks.delete(key)
    })
    return task
}

async function removeThrough(base, path) {
    try {
        const root = await base()
        if (!path.length) {
            // The root itself: empty it rather than remove it, because a host
            // handed us that handle and may still be holding it.
            const names = []
            for await (const name of root.keys()) names.push(name)
            for (const name of names) await root.removeEntry(name, { recursive: true })
            return
        }
        const parent = await directoryOf(root, path.slice(0, -1), false)
        await parent.removeEntry(path.at(-1), { recursive: true })
    } catch (error) {
        if (NOT_FOUND.has(error?.name)) return // already gone is what the caller asked for
        throw error
    }
}

async function entriesThrough(base, path) {
    try {
        const directory = await directoryOf(await base(), path, false)
        const out = []
        for await (const handle of directory.values()) out.push({ name: handle.name, isDir: handle.kind === "directory" })
        return out
    } catch (error) {
        // `NotFoundError` is "nothing there" — walking is a statement about what
        // IS there. `TypeMismatchError` is the platform saying the name exists and
        // is a FILE, which is a different thing: answering `[]` for it is how a
        // caller mistakes a file for an empty directory (see node.js for the
        // measurement — a build read every file as a directory the day a driver
        // started answering `[]`).
        if (error?.name === "NotFoundError") return []
        if (error?.name === "TypeMismatchError") throw new Error(`[udb/driver] entries(${JSON.stringify(path)}) — that path is a FILE, not a directory. A file has no entries, and answering an empty list would let a caller read it as an empty directory. Ask isDir() to tell them apart.`)
        throw error
    }
}

export function opfsDriver({ root = null, scope = "OPFS" } = {}) {
    const base = async () => root ?? (await navigator.storage.getDirectory())
    const locks = new Map()

    return {
        scope,
        readBytes: (path) => readThrough(base, path),
        writeBytes: (path, bytes) => writeThrough(base, locks, path, bytes),
        remove: (path) => removeThrough(base, path),
        entries: (path) => entriesThrough(base, path),

        // ── The file-door verbs ────────────────────────────────────────────
        // Four verbs are what THIS package calls; these six are what a host with
        // a file layer of its own needs, and every one of them was being written
        // again by that host over the same backend. The port still demands four
        // (src/contract.js): a package may ship more than it asks for, and asking
        // for ten would impose a law this package does not live by.
        list: async (path) => (await entriesThrough(base, path)).map((entry) => entry.name),
        exists: async (path) => {
            if (!path.length) return true
            try {
                const parent = await directoryOf(await base(), path.slice(0, -1), false)
                for await (const name of parent.keys()) if (name === path.at(-1)) return true
                return false
            } catch (error) {
                if (NOT_FOUND.has(error?.name)) return false
                throw error
            }
        },
        isDir: async (path) => {
            if (!path.length) return true
            try {
                await directoryOf(await base(), path, false)
                return true
            } catch {
                return false
            }
        },
        mkdir: async (path) => {
            await directoryOf(await base(), path, true)
        },
        move: async (from, to) => {
            const bytes = await readThrough(base, from)
            if (bytes === null) return
            await writeThrough(base, locks, to, bytes)
            await removeThrough(base, from)
        },
        copyFile: async (from, to) => {
            const bytes = await readThrough(base, from)
            if (bytes === null) return
            await writeThrough(base, locks, to, bytes)
        }
    }
}

export default opfsDriver
