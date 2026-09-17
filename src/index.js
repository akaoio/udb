/**
 * UDB — the universal data door.
 *
 * Devs call DB and only DB; where a datum lives and how it travels is the
 * mount table's business. One grammar for every mount:
 *
 *   DB.get("statics").get("chains").get("1").get("configs.json").once()
 *   DB.get(["statics", "chains", "1", "configs.json"]).once()   // same node
 *   DB.get("local").get("theme").peek()                          // sync, preloaded
 *   DB.get("lives").get("pools").get(chain).get(addr).put(data)  // one write, fanned out
 *   DB.get("orders").find({ status: "open" }).on(update)         // live query
 *
 * Mounts:
 *   statics — read-only, content-addressed loader (statics.js engine):
 *             RAM memo → at-rest bytes validated by their own infohash →
 *             the host's loader. ONE at-rest copy. once/on/map.
 *   local   — the small-config kv (local.js engine). peek/put/del/clear/on, flat
 *             keys only. peek is synchronous BY CONTRACT (hosts read these
 *             at module-import time).
 *   lives   — live mirrors. put persists AND announces the same-path
 *             fragment through the realm's registered DB.announce transport
 *             — the one writer that replaces the dual-write disease.
 *
 * Free roots are collections: documents by _id, find(filter) at the root,
 * find().on() to keep the query live. One filter language, per-environment
 * engines — all injected by the host (see createDB below).
 *
 * A verb a mount does not support throws by name; the grammar never
 * silently no-ops.
 */
import { GatewayNode } from "./gateway.js"
import { Local } from "./local.js"
import { conform } from "./contract.js"

// Plain-data deep clone that simply drops functions — announce fragments are
// data by definition, and the transport must never share references with the
// store.
function clone(data, seen = new WeakMap()) {
    if (typeof data !== "object" || data === null) return data
    if (seen.has(data)) return seen.get(data)
    const copy = Array.isArray(data) ? [] : {}
    seen.set(data, copy)
    for (const [key, value] of Object.entries(data)) if (typeof value !== "function") copy[key] = clone(value, seen)
    return copy
}

function localKey(path) {
    if (path.length !== 1) throw new Error("DB: the local mount holds flat keys — DB.get('local').get(key)")
    return path[0]
}

/**
 * createDB — wire the door to a host's engines.
 *
 *   statics     — engine from statics({ load, driver, infohash, hashes, metadata, browser, dev })
 *   lives       — { store }: a chain-store (get/put/del/once/on/map + ready)
 *   collections — collectionMount(name) from collections({ browser, sql, kv })
 *   local       — optional engine override; defaults to the built-in local.js
 *
 * Returns the DB object: get/ready/wipe plus the settable announce hook (a
 * worker realm registers its own transport once; reader realms leave it
 * null).
 */
export function createDB({ statics, lives, collections, local = Local }) {
    // The `lives` store is checked here rather than at the first put: a store
    // without `del` answered `DB.wipe()` with a TypeError from inside this file
    // (see contract.js). `statics` and `collections` check their own injections
    // where they are built.
    conform("createDB().lives", { store: lives?.store })
    const MOUNTS = {
        statics: {
            name: "statics",
            verbs: {
                // The node path is mount-RELATIVE; the engine keys by the
                // FULL path (it doubles as the URL) — the mount is where the
                // two coordinate systems meet, so it re-prefixes here and
                // nowhere else.
                once: (path) => {
                    if (!path.length) throw new Error("DB: statics root is not readable — name a file")
                    return statics.once(["statics", ...path])
                },
                // Reactivity and enumeration over the CACHE tier: on() fires
                // when this realm's loader lands fresh data; map() walks what
                // is at rest locally — the honest scope of a cache.
                on: (path, callback) => statics.on(["statics", ...path], callback),
                map: (path, callback) => statics.map(["statics", ...path], callback)
            }
        },
        local: {
            name: "local",
            verbs: {
                peek: (path) => local.peek(localKey(path)),
                put: (path, value) => local.put(localKey(path), value),
                del: (path) => local.del(localKey(path)),
                on: (path, callback) => local.on(localKey(path), callback)
            }
        },
        lives: {
            name: "lives",
            verbs: {
                once: (path) => lives.store.get(path).once(),
                map: (path, callback) => lives.store.get(path).map(callback),
                on: (path, callback) => lives.store.get(path).on(callback),
                // The one writer: persist at the path, announce the same-path
                // fragment through the realm's transport. The two halves
                // cannot disagree — there is only one input.
                put: async (path, value) => {
                    await lives.store.get(path).put(value)
                    if (DB.announce) {
                        let fragment = value
                        for (let i = path.length - 1; i >= 0; i--) fragment = { [path[i]]: fragment }
                        DB.announce(clone(fragment))
                    }
                    return value
                }
            }
        }
    }

    const DB = {
        // Cross-realm announce hook for the lives mount — set by the host's
        // writer realm, read by the lives put verb above.
        announce: null,

        get(key) {
            const segments = Array.isArray(key) ? key : [key]
            if (!segments.length) throw new Error("DB: a mount name is required — DB.get('statics' | 'local' | 'lives')")
            // Named mounts first; every free root IS a collection.
            const mount = MOUNTS[segments[0]] ?? collections(segments[0])
            return new GatewayNode(mount, segments.slice(1))
        },

        // One readiness for the whole door.
        ready: Promise.all([lives?.store?.ready].filter(Boolean)),

        // Wipe the data the door owns: the lives store and the statics
        // cache. Host-level reset remains the wider wipe.
        async wipe() {
            await Promise.all([lives?.store?.del([]), statics.wipe()])
        }
    }

    return DB
}

export { GatewayNode } from "./gateway.js"
export { match, compile } from "./filter.js"
export { collections } from "./collections.js"
export { statics } from "./statics.js"
export { Local } from "./local.js"
export { CallQueue } from "./sqlite/queue.js"
export { sqlite, engine as sqliteEngine, VERBS as SQL_VERBS, LOCAL_ONLY as SQL_LOCAL_ONLY, WASM_ASSETS } from "./sqlite/index.js"
export { walk } from "./walk.js"
// The replication engine is NOT re-exported here: it imports node:child_process
// at its top level, and a static import of that takes a browser page down before
// a line runs. A server reaches it at `@akaoio/udb/src/replica/index.js`; what is
// safe for every realm is the POLICY, which is data and imports nothing.
export { REPLICATED_PRAGMAS, BUSY_MS } from "./replica/pragmas.js"
// The byte driver door picks its realm the way the SQL door does — by asking
// what exists, behind a dynamic import — so it is safe in every realm. The
// conformance kit travels with it: a host injecting its OWN driver runs the same
// assertions against it, in its own suite.
export { driver, checkDriver, checkFileDoor, supportsOPFS } from "./driver/index.js"
// The loader is the BODY of the `load` port — this package stated that port's law
// in `statics/conformance.js` and shipped nothing for years of it. `checkLoad` is
// exported beside it so a host can run the law over whichever body it uses.
export { loader } from "./loader.js"
// The DOOR over the store: every verb a host was writing over the byte driver.
export { fs } from "./fs.js"
// THE SEAM ITSELF. A host's first question is "which ports does this package
// have", and until now the only answer was a deep import of `src/contract.js`
// while `index.js` was the front door — so the registry, the one thing built to
// be read from outside, was the one thing the entry point did not offer.
export { PORTS, NEEDS, conform } from "./contract.js"
// Tree verbs over the driver port, the family `walk` was already in.
export { copyTree, matches, find } from "./tree.js"
// The chain-store two of the ports want, over that same driver — and the kit
// that says what a store MEANS, for a host wiring its own.
export { chainStore } from "./kv/index.js"
export { checkStore } from "./kv/conformance.js"
export { DRIVER, STORE, requires, requiresFunction } from "./contract.js"
// Which realm this is — exported because a host that needs the answer and finds
// no export writes the same two lines, and then there are two homes for one law
// (akao had them, byte for byte, until 2026-09-17).
export { detectEnvironment, NODE, BROWSER } from "./env.js"
// The loader port's meaning, for the one port whose contract was never written
// anywhere — a miss ANSWERS undefined, and the engine asks that on every read.
export { checkLoad } from "./statics/conformance.js"
export default createDB
