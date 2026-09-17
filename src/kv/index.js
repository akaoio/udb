import { PORTS, requires } from "../contract.js"
import { walk } from "../walk.js"

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

    const tell = (path, value) => {
        for (const callback of watchers.get(keyOf(path)) ?? []) {
            try {
                callback(value, path)
            } catch {
                // A subscriber that throws is a subscriber's problem: the write
                // has already settled, and the next subscriber is owed its call.
            }
        }
    }

    /**
     * Tell this path's subscribers, then every ANCESTOR that has one.
     *
     * An ancestor hears the assembled subtree — the same thing `once()` would
     * answer it — because that is what it subscribed to. The assembly is paid
     * for ONLY where somebody is listening: it costs a walk, and a tree with no
     * subscribers must not pay for one on every write.
     *
     * What is deliberately NOT done: notifying paths made of a document's own
     * FIELDS. A store whose nodes are paths should not decide that `{a: {b: 1}}`
     * written at `x` also means a write at `x/a/b` — that blurs document and
     * tree, and nothing has ever subscribed that way.
     */
    const announce = async (path, value) => {
        tell(path, value)
        for (let depth = path.length - 1; depth > 0; depth--) {
            const ancestor = path.slice(0, depth)
            if (!watchers.has(keyOf(ancestor))) continue
            tell(ancestor, await assemble(ancestor))
        }
    }

    /**
     * Every document under a path, with the path each was found at.
     *
     * Through `walk`, which is this package's one primitive for enumerating what
     * is at rest — a second recursion over the same driver is how two walks
     * drift apart.
     */
    async function under(path, visit) {
        const base = root.length + path.length
        let count = 0
        await walk(driver, directoryOf(path), async (filePath) => {
            const name = filePath.at(-1)
            if (typeof name !== "string" || !name.endsWith(".json")) return
            const relative = [...filePath.slice(base, -1), name.slice(0, -5)]
            const value = await read([...path, ...relative])
            if (value === undefined) return
            count++
            await visit(value, relative)
        })
        return count
    }

    /**
     * What a read of a NON-LEAF answers: the subtree, assembled.
     *
     * The exact document wins. Failing that, everything stored underneath comes
     * back as one nested object — because a chain-store is a tree, and a caller
     * that wrote `pools/<chain>/<address>` four levels down and then asks for
     * `pools` is asking for the pools, not for nothing.
     *
     * This is not a nicety: it is what a real host's store already did, and the
     * only reason `chainStore` could not replace it. Measured against akao
     * 2026-09-17 — two of its routes read a branch and render what comes back,
     * and this store answered `undefined` there.
     */
    async function assemble(path) {
        const exact = await read(path)
        if (exact !== undefined) return exact
        let found = false
        const out = {}
        await under(path, (value, relative) => {
            found = true
            let node = out
            for (const segment of relative.slice(0, -1)) node = node[segment] ??= {}
            node[relative.at(-1)] = value
        })
        return found ? out : undefined
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
            once: () => assemble(path),
            put: async (value) => {
                if (!path.length) throw new Error("kv: put() needs a path — the root of a store is not a document")
                if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("kv: a chain-store holds documents (plain objects)")
                await driver.writeBytes(fileOf(path), encoder.encode(JSON.stringify(value)))
                await announce(path, value)
                return value
            },
            del: async () => {
                if (!path.length) throw new Error("kv: del() needs a path — the store's own del() is what empties it")
                await driver.remove(fileOf(path))
                await driver.remove(directoryOf(path))
                await announce(path, undefined)
            },
            /**
             * Every document under this node, at ANY depth, with the full path
             * each was found at — `callback(value, path)`, and the count back.
             *
             * At any depth rather than one level, because that is what a prefix
             * means in a tree and what a real host's store does. A collection's
             * documents are one level down, so the `kv` engine sees exactly what
             * it saw before; a caller enumerating a deeper branch now gets the
             * branch instead of its first floor.
             *
             * It reads what is AT REST rather than a list held in memory, so a
             * document another process wrote into the same directory is seen.
             */
            map: async (callback) => under(path, (value, relative) => callback(value, [...path, ...relative])),
            on: (callback) => {
                const key = keyOf(path)
                if (!watchers.has(key)) watchers.set(key, new Set())
                watchers.get(key).add(callback)
                assemble(path).then((value) => {
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
