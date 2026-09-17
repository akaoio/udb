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
 * driver: the tests hand it a plain in-memory implementation of the three
 * handle methods used here, so the queue, the create flags and the error mapping
 * are measured without a browser. A browser is still where OPFS is real, and the
 * host's own suite is where that is proven; what is proven here is the logic.
 */
const NOT_FOUND = new Set(["NotFoundError", "TypeMismatchError"])

/** The directory handle for a path, optionally creating it on the way down. */
async function directoryOf(root, path, create) {
    let handle = root
    for (const segment of path) handle = await handle.getDirectoryHandle(segment, { create })
    return handle
}

export function opfsDriver({ root = null, scope = "OPFS" } = {}) {
    const base = async () => root ?? (await navigator.storage.getDirectory())
    const locks = new Map()

    const fileOf = async (path, create) => {
        const directory = await directoryOf(await base(), path.slice(0, -1), create)
        return directory.getFileHandle(path.at(-1), { create })
    }

    return {
        scope,
        readBytes: async (path) => {
            try {
                const handle = await fileOf(path, false)
                const file = await handle.getFile()
                return new Uint8Array(await file.arrayBuffer())
            } catch (error) {
                if (NOT_FOUND.has(error?.name)) return null
                throw error
            }
        },
        writeBytes: async (path, bytes) => {
            // One writable per file at a time, or `NoModificationAllowedError`.
            // The stored promise is silenced so a failed write does not poison
            // the next one in the queue, and the entry is dropped when it is the
            // last in the chain so the Map cannot grow forever.
            const key = path.join("/")
            const previous = locks.get(key) ?? Promise.resolve()
            const task = previous.then(async () => {
                const handle = await fileOf(path, true)
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
        },
        remove: async (path) => {
            try {
                const parent = await directoryOf(await base(), path.slice(0, -1), false)
                if (!path.length) {
                    // The root itself: empty it rather than remove it, because a
                    // host handed us that handle and may still be holding it.
                    for await (const name of (await base()).keys()) await (await base()).removeEntry(name, { recursive: true })
                    return
                }
                await parent.removeEntry(path.at(-1), { recursive: true })
            } catch (error) {
                if (NOT_FOUND.has(error?.name)) return // already gone is what the caller asked for
                throw error
            }
        },
        entries: async (path) => {
            try {
                const directory = await directoryOf(await base(), path, false)
                const out = []
                for await (const handle of directory.values()) out.push({ name: handle.name, isDir: handle.kind === "directory" })
                return out
            } catch (error) {
                if (NOT_FOUND.has(error?.name)) return []
                throw error
            }
        }
    }
}

export default opfsDriver
