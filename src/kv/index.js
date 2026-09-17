import { PORTS, requires } from "../contract.js"

/**
 * A chain-store: documents in a tree, `get(...).put/once/del/map/on`.
 *
 * ── Why this package ships one ─────────────────────────────────────────────
 *
 * Two of its ports want one — `lives.store` and the `kv` engine of
 * `collections` — and this package shipped neither, so "bring a chain-store"
 * was asked of every host on top of "bring a byte driver". A host that wanted
 * documents in a tree had to write the tree.
 *
 * ── Why it persists through the DRIVER port, in both realms ────────────────
 *
 * The realm question was already answered once, by `driver()`: OPFS in a
 * browser, node:fs on a server. Answering it a second time here — an IndexedDB
 * engine beside a file engine — would be two more implementations to keep in
 * step, and two more places for "what does a miss mean" to drift. So this store
 * is realm-blind: it reads and writes bytes, and the driver knows where.
 *
 * ── The layout, and why a node can be BOTH ─────────────────────────────────
 *
 * A document at `["a", "b"]` is the bytes at `a/b.json`; the children of
 * `["a", "b"]` live in `a/b/`. Both at once is normal — a node that holds a
 * value and has children underneath it — and neither is in the other's way.
 *
 * One document per file, on purpose: the engine this replaces kept a collection
 * in ONE json file and rewrote the whole thing on every save, which is fine
 * until it is not, and is silently quadratic in a directory that grows.
 *
 * ── What `on()` promises, and what it does not ─────────────────────────────
 *
 * Realm-local, like every other `on()` this package offers: a write in another
 * process is not heard here. Announcing across realms is the host's transport
 * (akao's `announce` hook), not a store's job — a store that tried would be
 * inventing a second transport beside the one its host already has.
 */
export function chainStore({ driver, root = [] } = {}) {
    requires(driver, PORTS.driver.methods, "driver", "chainStore()", PORTS.driver.fields)

    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const watchers = new Map()
    const keyOf = (path) => path.join("/")
    const fileOf = (path) => [...root, ...path.slice(0, -1), `${path.at(-1)}.json`]
    const directoryOf = (path) => [...root, ...path]

    const announce = (path, value) => {
        for (const callback of watchers.get(keyOf(path)) ?? []) {
            try {
                callback(value, path)
            } catch {
                // A subscriber that throws is a subscriber's problem: the write
                // has already settled, and the next subscriber is owed its call.
            }
        }
    }

    async function read(path) {
        if (!path.length) return undefined
        const bytes = await driver.readBytes(fileOf(path))
        if (!bytes?.length) return undefined
        try {
            return JSON.parse(decoder.decode(bytes))
        } catch {
            // A body that is not a document is not a document. Answering
            // `undefined` keeps a corrupt file from throwing out of every read
            // that walks past it — the caller asked whether there is a value.
            return undefined
        }
    }

    function node(path) {
        return {
            path,
            get: (segment) => node([...path, ...(Array.isArray(segment) ? segment : [segment])]),
            once: () => read(path),
            put: async (value) => {
                if (!path.length) throw new Error("kv: put() needs a path — the root of a store is not a document")
                if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("kv: a chain-store holds documents (plain objects)")
                await driver.writeBytes(fileOf(path), encoder.encode(JSON.stringify(value)))
                announce(path, value)
                return value
            },
            del: async () => {
                if (!path.length) throw new Error("kv: del() needs a path — the store's own del() is what empties it")
                await driver.remove(fileOf(path))
                await driver.remove(directoryOf(path))
                announce(path, undefined)
            },
            /**
             * Every CHILD document of this node, one level down — the level a
             * collection is, which is what the `kv` engine enumerates. It reads
             * what is at rest rather than a list held in memory, so a document
             * another process wrote into the same directory is seen.
             */
            map: async (callback) => {
                const seen = []
                for (const entry of await driver.entries(directoryOf(path))) {
                    const name = entry?.name ?? entry
                    if (typeof name !== "string" || entry?.isDir || !name.endsWith(".json")) continue
                    const id = name.slice(0, -5)
                    const value = await read([...path, id])
                    if (value === undefined) continue
                    seen.push(id)
                    await callback(value, [...path, id])
                }
                return seen
            },
            on: (callback) => {
                const key = keyOf(path)
                if (!watchers.has(key)) watchers.set(key, new Set())
                watchers.get(key).add(callback)
                read(path).then((value) => {
                    if (value !== undefined) callback(value, path)
                })
                return () => watchers.get(key)?.delete(callback)
            },
            off: (callback) => {
                if (callback) watchers.get(keyOf(path))?.delete(callback)
                else watchers.delete(keyOf(path))
            }
        }
    }

    return {
        /** A store's scope is its driver's — two stores over one scope are one store. */
        get scope() {
            return driver.scope
        },
        ready: Promise.resolve(),
        get: (segment = []) => node(Array.isArray(segment) ? segment : [segment]),
        /**
         * Empty a subtree — `del([])` is the whole store, which is the call
         * `DB.wipe()` makes (`lives.store.del([])`). A path is accepted because
         * that is the shape the door uses, not because emptying half a store is
         * a common wish.
         */
        del: async (path = []) => {
            await driver.remove([...root, ...path])
            if (!path.length) watchers.clear()
        }
    }
}

export default chainStore
