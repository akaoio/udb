# @akaoio/udb

The **universal data door**: one chain grammar over every kind of data. Devs call `DB` and only `DB` — where a datum lives and how it travels is the mount table's business, not the caller's.

```js
DB.get("statics").get("chains").get("1").get("configs.json").once()
DB.get(["statics", "chains", "1", "configs.json"]).once()   // same node
DB.get("local").get("theme").peek()                          // sync, preloaded
DB.get("lives").get("pools").get(chain).get(addr).put(data)  // one write, fanned out
DB.get("orders").find({ status: "open" }).on(update)         // live query
```

## Mounts

| mount | what it is | verbs |
|---|---|---|
| `statics` | read-only, **content-addressed**: RAM memo → at-rest bytes validated by their own BEP3 infohash → the host's loader. ONE at-rest copy; a cached body proves itself, so no stale memo can poison it. | `once` `on` `map` |
| `local` | synchronous small-config kv (memo over localStorage; memo-only without it) | `peek` `put` `del` `on` |
| `lives` | live mirrors with ONE writer: `put` persists and announces the same-path fragment through `DB.announce` | `put` `once` `on` `map` |
| free roots | collections: documents by `_id`, `find(filter)` at the root, `find().on()` keeps the query live | `put` `once` `del` `find` |

A verb a mount does not support **throws by name** — the grammar never silently no-ops.

## The SQLite door

SQL is a language, and it is the same language in every realm — what differs is who executes it. Since 0.3.0 that engine lives here rather than in each host:

```js
import { sqlite } from "@akaoio/udb"

const db = await sqlite({ path: "data/chart/positions.db", pragmas: ["journal_mode=WAL", "busy_timeout=5000"] })  // Node
const db = await sqlite({ sqlite3, name: "akao" })      // inside a worker: WASM over OPFS
const db = await sqlite({ dispatch, name: "akao" })     // on a page: a proxy to that worker
```

The door is **async** because it imports only the engine this realm can run: `node.js` imports `node:sqlite` at its top level, and a static import of that would take the whole chain down in a browser. A caller that knows its realm can import `nodeDatabase` from `src/sqlite/node.js` directly and keep a synchronous open.

One contract: `exec` `all` `get` `run` `batch(queries)` `transaction(fn)` `close`. Two engines run the statements themselves (`local: true`) and offer two more that cannot cross a transport — `prepare(sql)` → `{ run, get, all, finalize }` and `sync` → `{ exec, all, get, run }`, both synchronous. The page's handle forwards the async verbs and refuses those two BY NAME.

Measured on one box, 20 000 writes + 20 000 reads: held statements **115.7 ms**, the same work through the async `sql`-string verbs **251.3 ms (+117 %)**, and with reads gathered into one synchronous transaction **152.5 ms (+32 %)**. A door without `prepare` makes the slow number the only option for code whose whole job is a loop.

- **`transaction(fn)` hands `fn` a SYNCHRONOUS handle and refuses a promise.** An `await` between BEGIN and COMMIT gives the event loop away with the transaction open, and anything else reaching that connection lands inside it — a write lost or rolled back, with nothing in a log to say so. Across a transport a function cannot travel at all, so the remote handle throws by name and points at `batch`, the same atomicity expressed as data.
- **Several statements with parameters are refused.** Measured on Node v24.21: `prepare("CREATE TABLE a(x); CREATE TABLE b(y)").all()` creates only `a`, with no error. The door turns that silent loss into a refusal.
- **Rows carry an ordinary prototype in both engines** — `node:sqlite` answers null-prototype objects, so the door normalises them; a row type that depends on the realm is a difference this door exists to remove.
- **Pragmas on Node are the caller's.** Whoever owns the directory states its durability policy; the engine only knows how to run SQL. The browser engine states three of its own (WAL, `synchronous = NORMAL`, manual checkpointing) because OPFS has no second writer and every fsync is felt.
- **The WASM build is this package's dependency, but a host never declares it**: npm installs it transitively. A page has no module resolution, so `WASM_ASSETS` declares which files a host's builder must copy next to its worker, and the host passes the initialised module in.

## Filter language

One meaning, two backends: `match(doc, filter)` (in-process matcher) and `compile(filter)` (SQL WHERE over `json_extract`). Ops `$eq $ne $gt $gte $lt $lte $in $nin`, combinators `&`/`|`, dot paths, honest null-vs-missing.

## The host injects what only it can know

UDB imports nothing from its host — the SQLite engine it now carries is reached through parameters too (the module, or a transport). What a host still wires in is everything that is about THIS host rather than about a realm: how bytes are loaded and stored, what a content address is, how a realm announces a write.

```js
import { createDB, statics, collections } from "@akaoio/udb"

const DB = createDB({
    statics: statics({
        load,        // (path, {fresh, quiet}) → data — your tiered loader (HTTP/disk/P2P)
        driver,      // { readBytes, writeBytes, remove, entries } — OPFS, node:fs, anything
        infohash,    // (bytes, name) → { v1 } — the content address your build publishes
        hashes,      // (path) → { ok, status, hash } — the hash your ORIGIN states for that path
        metadata,    // (name) → true when the file describes others (your sidecars)
        browser, dev
    }),
    lives: { store },                      // a chain-store (get/put/del/once/on/map + ready)
    collections: collections({ browser, sql, kv })  // sql: SQLite-like handle; kv: chain-store
})
```

Reactivity (`on`, `find().on`) is **realm-local by design** — cross-realm fan-out is the host's transport concern (`DB.announce`).

## Install

```sh
npm install github:akaoio/udb
```

From GitHub on purpose — this package evolves with its hosts.

## Test

```sh
npm test   # node --test, zero dependencies — and REAL parts, not stubs
```

The suite runs on the genuine article wherever one exists dependency-free: the filter conformance table runs through the JS matcher AND a REAL SQLite (node:sqlite, JSON1); the statics engine runs on a REAL filesystem with a REAL digest of the actual bytes; the browser transport cases answer with real Response objects. The one remaining test double is the kv chain-store — a documented CONTRACT stand-in whose real implementation belongs to the host (akao pins it against real IndexedDB in its conformance tier).
