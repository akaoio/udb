/**
 * The browser engine: SQLite compiled to WebAssembly, at rest in OPFS.
 *
 * ── Why this half must run in a worker, and therefore why the module arrives ──
 * ── as a parameter ──────────────────────────────────────────────────────────
 *
 * The OPFS VFS needs a synchronous access handle, and that API exists only in a
 * dedicated worker. So this engine cannot be constructed on a page; the page
 * talks to it through `remote.js` instead. UDB owns no worker — how a host
 * spawns one, and how it ships messages, is the host's own thread machinery —
 * so the host loads the `sqlite3` module inside ITS worker and hands it in here.
 * That keeps one law (how to speak SQLite) in one place while the transport
 * stays where transports belong.
 *
 * ── The pragmas, and why they are not the caller's here ────────────────────
 *
 * Unlike the Node engine, these three are the ENGINE's: OPFS has no second
 * writer to wait for, and what it does have is a cost per fsync that a browser
 * feels. WAL plus `synchronous = NORMAL` plus a checkpoint this file drives
 * itself (rather than SQLite's automatic one) is the shape that keeps a page
 * responsive while a few thousand rows land. A caller may still add pragmas of
 * its own; these run first.
 */
import { multiple } from "./statements.js"

/** Flush the WAL when this many writes have piled up, or this often, whichever comes first. */
const CHECKPOINT_WRITES = 200
const CHECKPOINT_MS = 2000

/**
 * Open one OPFS database. `sqlite3` is the initialised module, from the host.
 *
 * Throws by name when the OPFS VFS is absent, which is the one failure that
 * would otherwise look like a database that simply forgets everything: without
 * it the module happily opens an in-memory database instead.
 */
export function wasmDatabase({ sqlite3, name = "udb", pragmas = [] } = {}) {
    if (!sqlite3?.oo1) throw new Error("sqlite: the WASM engine needs an initialised sqlite3 module — the host loads it and passes it in")
    if (!sqlite3.oo1.OpfsDb) throw new Error("sqlite: no OPFS VFS in this context — the WASM engine must run in a dedicated worker, or it would open an in-memory database that forgets everything on reload")

    const db = new sqlite3.oo1.OpfsDb(`/${name}.db`)
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = NORMAL") // fsync at checkpoints, not at every commit
    db.exec("PRAGMA wal_autocheckpoint = 0") // this file drives the checkpoint instead
    for (const pragma of pragmas) db.exec(`PRAGMA ${pragma}`)

    let pending = 0
    const checkpoint = () => {
        if (!pending) return
        db.exec("PRAGMA wal_checkpoint(PASSIVE)")
        pending = 0
    }
    const wrote = () => {
        if (++pending >= CHECKPOINT_WRITES) checkpoint()
    }
    const timer = setInterval(checkpoint, CHECKPOINT_MS)

    const rows = (sql, params) => {
        const collected = []
        db.exec({ sql, bind: params ?? [], rowMode: "object", callback: (row) => collected.push(row) })
        return collected
    }

    /**
     * One statement's rows. The multi-statement refusal is SHARED with the Node
     * engine on purpose: that engine cannot run several statements with
     * parameters without losing all but the first, and two engines that accept
     * different SQL are two dialects wearing one contract.
     */
    const query = (sql, params) => {
        if (multiple(sql)) {
            if ((params ?? []).length) throw new Error(`sqlite: ${JSON.stringify(String(sql).slice(0, 60))}… holds more than one statement AND takes parameters — send them one at a time, the way the Node engine requires`)
            db.exec(sql)
            return []
        }
        return rows(sql, params)
    }

    const sync = {
        exec: (sql, params) => query(sql, params),
        all: (sql, params) => query(sql, params),
        get: (sql, params) => query(sql, params)[0] ?? null,
        run: (sql, params) => {
            db.exec({ sql, bind: params ?? [] })
            wrote()
            return { changes: db.changes(), lastId: db.selectValue("SELECT last_insert_rowid()") }
        }
    }

    return {
        name,
        local: true,
        exec: async (sql, params) => sync.exec(sql, params),
        all: async (sql, params) => sync.all(sql, params),
        get: async (sql, params) => sync.get(sql, params),
        run: async (sql, params) => sync.run(sql, params),
        batch: async (queries = []) => {
            const answers = db.transaction(() => queries.map(({ sql, params }) => sync.exec(sql, params)))
            wrote()
            return answers
        },
        transaction: async (work) => {
            const answer = db.transaction(() => {
                const value = work(sync)
                if (value && typeof value.then === "function") throw new Error("sqlite: a transaction body must be synchronous — an await between BEGIN and COMMIT lets another caller's statements land inside this transaction")
                return value
            })
            wrote()
            return answer
        },
        close: async () => {
            clearInterval(timer)
            db.exec("PRAGMA wal_checkpoint(FULL)")
            db.close()
        }
    }
}

export default wasmDatabase
