/**
 * The SQLite door — one contract, an engine per realm (akao #851).
 *
 * SQL is a LANGUAGE, and it is the same language in every realm this door runs
 * in. What differs is who executes it: the runtime's native build on Node, a
 * WASM build over OPFS in a browser worker, and — on a page, which cannot hold
 * the OPFS handle at all — a proxy to that worker. Three engines, one spelling:
 *
 *     exec(sql, params?)   → rows, or [] for a write
 *     all(sql, params?)    → rows
 *     get(sql, params?)    → one row, or null
 *     run(sql, params?)    → { changes, lastId }
 *     batch(queries)       → one result per query, in ONE transaction
 *     transaction(fn)      → fn's value; fn gets a SYNCHRONOUS handle
 *     close()
 *
 * and, on an engine that runs the statements itself (`local: true`), two more
 * that cannot cross a transport:
 *
 *     prepare(sql)         → { run, get, all, finalize }, synchronous
 *     sync                 → { exec, all, get, run }, synchronous
 *
 * Measured on this box, 20 000 writes + 20 000 reads: held statements 115.7 ms,
 * the same work through the async `sql`-string verbs 251.3 ms (+117 %). A door
 * without `prepare` makes the slow number the only option for code whose whole
 * job is a loop — and that code is exactly what a gateway is made of.
 *
 * ── Why this belongs to UDB and not to each host ───────────────────────────
 *
 * UDB already defines collections and compiles a filter into `WHERE
 * json_extract(…)`, so it has always spoken SQL — while every host had to write
 * the engine for BOTH realms itself. That is one law with a house per host, and
 * `local.js` here has carried a realm-specific engine (localStorage) since the
 * beginning, so there was never a rule keeping engines out — only an asymmetry
 * nobody had written down.
 *
 * ── Why the door is async, and each engine is not ──────────────────────────
 *
 * `node.js` imports `node:sqlite` at its top level, and a STATIC import of that
 * from here would be evaluated in every realm — so a browser loading this file
 * fails to resolve `node:sqlite` and the whole import chain dies before a single
 * line runs. (Measured the expensive way on 2026-09-16: akao's page stopped
 * mounting, and `page.waitForFunction` reported only a 120 s timeout — the
 * failure was three layers away from the message.) So the engine a realm cannot
 * run is never fetched: each branch imports its own, which makes this door
 * asynchronous.
 *
 * A caller that KNOWS its realm — a Node process opening a file it owns — can
 * import `nodeDatabase` directly from `./node.js` and keep a synchronous open.
 *
 * ── What is still the host's ────────────────────────────────────────────────
 *
 * Two things, and both because they are not about SQL:
 *
 *   • the WASM module — a page has no module resolution, so the host's builder
 *     copies the files `assets.js` declares and its worker loads them; the
 *     initialised module arrives here as a parameter.
 *   • the transport — how a page reaches its worker is the host's own thread
 *     machinery, injected as `dispatch`.
 *
 * ── `transaction(fn)` is the atomic unit, and `fn` must be synchronous ─────
 *
 * Both local engines hand `fn` a synchronous handle and refuse a promise. An
 * `await` between BEGIN and COMMIT gives the event loop away while the
 * transaction is open, and anything else reaching that connection in the window
 * lands inside it — a write lost, or rolled back, with nothing in any log to say
 * so. Across a transport the function cannot travel at all, so the remote handle
 * refuses by name and points at `batch`, which is the same atomicity as data.
 */
import { NODE } from "../env.js"

/** The verbs every engine answers — exported so a conformance suite needs no list of its own. */
export const VERBS = ["exec", "all", "get", "run", "batch", "transaction", "prepare", "close"]

/**
 * What only a LOCAL engine offers, because each is a handle or a call that cannot
 * cross a transport: a prepared statement, and the synchronous face.
 *
 * Declared rather than implied: a caller can ask `handle.local` before reaching
 * for either, and the remote handle refuses both BY NAME instead of being
 * emulated into something slower that behaves subtly differently.
 */
export const LOCAL_ONLY = ["prepare", "sync"]

/**
 * Open a database with whichever engine this realm can run.
 *
 * The choice is made from what is AVAILABLE, not from a realm flag alone: a
 * worker holding the `sqlite3` module runs the WASM engine, a page with a
 * `dispatch` gets the proxy, Node gets the native build. A browser context with
 * neither is refused out loud — the alternative is an in-memory database that
 * silently forgets everything on reload.
 */
export async function sqlite({ name = "udb", path, pragmas = [], sqlite3 = null, dispatch = null } = {}) {
    if (sqlite3) return (await import("./wasm.js")).wasmDatabase({ sqlite3, name, pragmas })
    if (dispatch) return (await import("./remote.js")).remoteDatabase({ dispatch, name })
    if (NODE) return (await import("./node.js")).nodeDatabase({ path: path ?? `${name}.db`, pragmas })
    throw new Error("sqlite: in a browser this door needs either an initialised `sqlite3` module (inside a worker) or a `dispatch` to one — opening an in-memory database instead would lose every write on reload")
}
export { WASM_ASSETS } from "./assets.js"
export { statements, multiple } from "./statements.js"
export default sqlite
