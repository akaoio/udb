/**
 * Collections — free roots of the DB door.
 *
 * One grammar, an engine per environment, both INJECTED by the host:
 *   sql — a SQLite-like handle factory (exec/run/get/all): docs live as
 *         (_id TEXT PRIMARY KEY, doc TEXT), find() compiles the filter to a
 *         WHERE over json_extract.
 *   kv  — a chain-store factory (get(name).get(id).put/once/del, map):
 *         the same filter, evaluated in process by the JS matcher.
 * The host's conformance suite keeps the two backends in lockstep — the
 * LANGUAGE is isomorphic, the engines are not.
 *
 * The document is the unit: put/once/del address exactly one _id, find()
 * queries the collection root, find().on() keeps that query live. Deeper
 * paths throw — a collection is not a tree. Results are ordered by _id in
 * both engines so parity is testable.
 */
import { match, compile } from "./filter.js"

const NAME_RE = /^[a-z][a-z0-9_]*$/

// ── Browser engine: SQLite JSON1 through the injected handle ────────────────

function browserEngine(name, sql) {
    let _db = null
    const ensured = async () => {
        _db ??= (async () => {
            const db = await sql()
            await db.exec(`CREATE TABLE IF NOT EXISTS "c_${name}" (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)`)
            return db
        })()
        return _db
    }
    return {
        put: async (id, doc) => {
            const db = await ensured()
            await db.run(`INSERT OR REPLACE INTO "c_${name}" (_id, doc) VALUES (?, ?)`, [id, JSON.stringify(doc)])
            return doc
        },
        once: async (id) => {
            const db = await ensured()
            const row = await db.get(`SELECT doc FROM "c_${name}" WHERE _id = ?`, [id])
            return row ? JSON.parse(row.doc) : undefined
        },
        del: async (id) => {
            const db = await ensured()
            await db.run(`DELETE FROM "c_${name}" WHERE _id = ?`, [id])
        },
        find: async (filter) => {
            const db = await ensured()
            const { where, params } = compile(filter)
            const rows = await db.all(`SELECT doc FROM "c_${name}" WHERE ${where} ORDER BY _id`, params)
            return rows.map((row) => JSON.parse(row.doc))
        }
    }
}

// ── Node engine: injected kv + the JS matcher ────────────────────────────────

function nodeEngine(name, kv) {
    let _store = null
    const store = async () => (_store ??= kv())
    return {
        put: async (id, doc) => {
            await (await store()).get(name).get(id).put(doc)
            return doc
        },
        once: async (id) => (await store()).get(name).get(id).once(),
        del: async (id) => (await store()).get(name).get(id).del(),
        find: async (filter) => {
            const found = []
            await (await store()).get(name).map((doc, path) => {
                if (match(doc, filter)) found.push([path.at(-1), doc])
            })
            // ordered by _id, same as the SQL engine — parity is testable
            return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, doc]) => doc)
        }
    }
}

// ── Live queries ─────────────────────────────────────────────────────────────
//
// find(filter).on(callback) — realm-local, like every other on() the door
// offers: a write from another realm does not notify here. Every SETTLED
// write to a collection re-runs each of its watchers through the REAL
// engine — the delivery has the same ordering and filter meaning as a
// one-shot find(), by construction, so live results can never drift from
// queried ones.

const _watchers = new Map() // collection name → Set<{ engine, filter, callback }>

async function $refresh(name) {
    const set = _watchers.get(name)
    if (!set?.size) return
    for (const watcher of [...set]) {
        let docs
        try {
            docs = await watcher.engine.find(watcher.filter)
        } catch {
            continue
        }
        if (!set.has(watcher)) continue // unsubscribed while the query ran
        try {
            watcher.callback(docs)
        } catch (error) {
            console.error("DB: find().on() callback failed:", error)
        }
    }
}

async function $watch(name, engine, filter, initial, callback) {
    // The find() promise the caller already holds IS the initial delivery —
    // one query serves both awaiting and subscribing.
    const docs = await initial
    let set = _watchers.get(name)
    if (!set) _watchers.set(name, (set = new Set()))
    const watcher = { engine, filter, callback }
    try {
        callback(docs)
    } catch (error) {
        console.error("DB: find().on() callback failed:", error)
    }
    set.add(watcher)
    return () => {
        set.delete(watcher)
        if (!set.size) _watchers.delete(name)
    }
}

// ── The mount factory ────────────────────────────────────────────────────────

function documentId(path) {
    if (path.length !== 1) throw new Error("DB: a collection addresses documents — DB.get(name).get(id)")
    return String(path[0])
}

/**
 * collections({ browser, sql, kv }) → collectionMount(name).
 * browser picks the engine; sql/kv are lazy factories the chosen engine
 * memoizes on first use.
 */
export function collections({ browser, sql, kv }) {
    const _mounts = new Map()

    return function collectionMount(name) {
        if (!NAME_RE.test(name)) throw new Error(`DB: "${name}" is not a valid collection name (${NAME_RE})`)
        if (_mounts.has(name)) return _mounts.get(name)

        const engine = browser ? browserEngine(name, sql) : nodeEngine(name, kv)
        const mount = {
            name: `collection:${name}`,
            verbs: {
                // Validation throws synchronously (the grammar never silently
                // no-ops); IO returns a promise. Watchers hear a write only
                // after it has SETTLED in the engine — awaiting a put means
                // every observer has already been redelivered.
                put: (path, doc) => {
                    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("DB: a collection stores documents (plain objects)")
                    const id = documentId(path)
                    return engine.put(id, doc).then(async (out) => {
                        await $refresh(name)
                        return out
                    })
                },
                once: (path) => engine.once(documentId(path)),
                del: (path) => {
                    const id = documentId(path)
                    return engine.del(id).then(() => $refresh(name))
                },
                find: (path, filter = {}) => {
                    if (path.length) throw new Error("DB: find() queries the collection root — DB.get(name).find(filter)")
                    return engine.find(filter)
                },
                watch: (path, filter, initial, callback) => {
                    if (path.length) throw new Error("DB: find().on() watches the collection root")
                    return $watch(name, engine, filter ?? {}, initial, callback)
                }
            }
        }
        _mounts.set(name, mount)
        return mount
    }
}

export default collections
