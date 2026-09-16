/**
 * The page's handle: every verb crosses a transport the HOST owns.
 *
 * The browser engine has to live in a worker (OPFS), so a page cannot hold a
 * database — it holds a proxy. What carries the message is not UDB's business:
 * `dispatch(method, params)` is injected, and a host wires it to whatever thread
 * machinery it already has.
 *
 * ── Why `transaction` throws here instead of being emulated ────────────────
 *
 * A transaction body is a FUNCTION, and a function does not cross postMessage.
 * Emulating one — BEGIN, then a round trip per statement, then COMMIT — would
 * hold a transaction open across the event loop for as long as the page takes to
 * ask the next question, which is exactly the hazard the synchronous rule in the
 * local engines exists to prevent. So the door refuses BY NAME and points at
 * `batch`, which is the same atomicity expressed as DATA and therefore something
 * a transport can carry.
 */

export function remoteDatabase({ dispatch, name = "udb" } = {}) {
    if (typeof dispatch !== "function") throw new Error("sqlite: a remote handle needs a dispatch(method, params) — the host's transport to the worker that holds the database")
    // One open per handle, awaited by every verb: the worker may be cold, and a
    // query that raced the open used to fail with "database not open".
    const ready = dispatch("open", { db: name })
    const ask = async (method, params) => {
        await ready
        return dispatch(method, { db: name, ...params })
    }
    return {
        name,
        local: false,
        exec: (sql, params) => ask("exec", { sql, params }),
        all: (sql, params) => ask("all", { sql, params }),
        get: (sql, params) => ask("get", { sql, params }),
        run: (sql, params) => ask("run", { sql, params }),
        batch: (queries = []) => ask("batch", { queries }),
        transaction: async () => {
            throw new Error("sqlite: transaction(fn) is not available across a transport — a function cannot be sent to the worker, and emulating it would hold the transaction open across the event loop. Use batch([{ sql, params }, …]), which is the same atomicity as data.")
        },
        // A prepared statement is a handle INSIDE the database, and a handle does
        // not cross a transport; a synchronous verb cannot cross one either. Both
        // refuse by name rather than being emulated into something slower and
        // subtly different.
        prepare: () => {
            throw new Error("sqlite: prepare(sql) is not available across a transport — a statement is a handle inside the database. Send the SQL with each call, or batch([…]) for a loop.")
        },
        get sync() {
            throw new Error("sqlite: there is no synchronous face across a transport — the database is in another thread. Await the async verbs, or batch([…]) for atomicity.")
        },
        close: () => ask("close", {})
    }
}

export default remoteDatabase
