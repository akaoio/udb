/**
 * The Node engine: SQLite through `node:sqlite`, the runtime's own build.
 *
 * ── Why not the WASM build here ────────────────────────────────────────────
 *
 * Measured on Node v24.21 with @sqlite.org/sqlite-wasm 3.53.0 (`dist/node.mjs`):
 * it initialises, it lists a VFS called `unix`, and it still cannot open a file
 * on disk — `SQLITE_CANTOPEN (14)`, and nothing appears on the filesystem. That
 * `unix` VFS addresses Emscripten's virtual filesystem inside the sandbox, not
 * the host's disk; `opfs` does not exist outside a browser, and `kvvfs` wants a
 * `localStorage` Node has not got. So the WASM build on Node is a database in
 * RAM that dies with the process — which also leaves nothing for a WAL-shipping
 * replicator to tail. The runtime's native build is not a shortcut here, it is
 * the only door that reaches at-rest bytes.
 *
 * ── Synchronous inside, asynchronous at the edge ───────────────────────────
 *
 * `node:sqlite` is synchronous. The door's verbs are async because the browser's
 * engine cannot be anything else, and one contract is the point. Wrapping a sync
 * call in a resolved promise costs a microtask and buys the same spelling in
 * three realms.
 *
 * `transaction(fn)` is the exception, and deliberately: `fn` receives a
 * SYNCHRONOUS handle and must not return a promise. An `await` between BEGIN and
 * COMMIT hands the event loop away while the transaction is open, and anything
 * else that reaches this same connection in that window lands INSIDE the
 * transaction — a lost write or an unexpected rollback, with nothing to read in
 * a log. Refusing a promise there turns that into an error at the call site.
 */
import { DatabaseSync } from "node:sqlite"
import { multiple } from "./statements.js"

/**
 * One row, with an ordinary prototype.
 *
 * `node:sqlite` answers rows as NULL-PROTOTYPE objects while the WASM engine
 * answers ordinary ones, and a door whose row type depends on the realm is a door
 * that has not removed the difference it exists to remove: `deepStrictEqual`
 * tells them apart, so does anything reading `row.constructor` or a method off
 * Object.prototype. A shallow copy per row is the price, and it is paid here
 * rather than in every caller that might be the one to notice.
 */
const plain = (row) => (row ? { ...row } : row)

/** How a caller's params reach `node:sqlite`: positional spread, named as one object. */
const bound = (params) => (params === undefined || params === null ? [] : Array.isArray(params) ? params : [params])

/**
 * Open one database file (or `:memory:`), with `pragmas` applied in order.
 *
 * The pragmas are the CALLER's: this engine knows how to run SQL, not which
 * durability policy a directory is under — `journal_mode`, `busy_timeout` and
 * the rest are stated by whoever owns the file.
 */
export function nodeDatabase({ path = ":memory:", pragmas = [] } = {}) {
    const db = new DatabaseSync(path)
    for (const pragma of pragmas) db.exec(`PRAGMA ${pragma}`)

    // Prepared statements are cached by their text: a store that writes one row
    // per swap re-uses the same INSERT thousands of times, and re-compiling it
    // each time is the whole cost of the call.
    const cache = new Map()
    const prepared = (sql) => {
        let statement = cache.get(sql)
        if (!statement) cache.set(sql, (statement = db.prepare(sql)))
        return statement
    }

    /**
     * The one refusal, stated once for every verb that prepares.
     *
     * `prepare` compiles the FIRST statement and drops the rest WITHOUT SAYING
     * SO (measured, see statements.js). `exec` can fall back to the multi-
     * statement door; the row-returning verbs cannot, so for them this is
     * always an error rather than a silent half-run.
     */
    const single = (sql, door) => {
        if (!multiple(sql)) return
        const head = `sqlite: ${JSON.stringify(String(sql).slice(0, 60))}… holds more than one statement`
        const why = "the platform prepares the first and drops the rest in silence"
        if (door === "exec") throw new Error(`${head} AND takes parameters — exec() runs a script, but not a script with parameters: ${why}. Send them one at a time.`)
        throw new Error(`${head}, and ${door}() prepares — ${why}. Send them one at a time, or use exec() for a script.`)
    }

    /** One statement's rows — [] for a write, which is what every caller expects of DML. */
    const query = (sql, params) => {
        if (multiple(sql)) {
            // Several statements and no parameters is a SCRIPT, and `exec` runs
            // every one of them. With parameters there is no such door.
            if (bound(params).length) single(sql, "exec")
            db.exec(sql)
            return []
        }
        return prepared(sql).all(...bound(params)).map(plain)
    }

    /** The synchronous face, which is what a transaction body is handed. */
    const sync = {
        exec: (sql, params) => query(sql, params),
        all: (sql, params) => (multiple(sql) ? query(sql, params) : prepared(sql).all(...bound(params)).map(plain)),
        get: (sql, params) => {
            single(sql, "get")
            return plain(prepared(sql).get(...bound(params))) ?? null // node:sqlite answers undefined; the door says null
        },
        run: (sql, params) => {
            single(sql, "run")
            const answer = prepared(sql).run(...bound(params))
            return { changes: Number(answer.changes), lastId: Number(answer.lastInsertRowid) }
        }
    }

    const transaction = (work) => {
        db.exec("BEGIN")
        let answer
        try {
            answer = work(sync)
            if (answer && typeof answer.then === "function") throw new Error("sqlite: a transaction body must be synchronous — an await between BEGIN and COMMIT lets another caller's statements land inside this transaction")
        } catch (error) {
            db.exec("ROLLBACK")
            throw error
        }
        db.exec("COMMIT")
        return answer
    }

    return {
        path,
        local: true, // a handle that runs the statements itself, so it can hold a transaction open
        exec: async (sql, params) => sync.exec(sql, params),
        all: async (sql, params) => sync.all(sql, params),
        get: async (sql, params) => sync.get(sql, params),
        run: async (sql, params) => sync.run(sql, params),
        batch: async (queries = []) => transaction(() => queries.map(({ sql, params }) => sync.exec(sql, params))),
        transaction: async (work) => transaction(work),
        close: async () => {
            cache.clear()
            db.close()
        }
    }
}

export default nodeDatabase
