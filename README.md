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
| `local` | synchronous small-config kv (memo over localStorage; memo-only without it) | `peek` `put` `del` `clear` `on` |
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
const db = await sqlite({ path: "restored.db", readOnly: true })         // inspect without touching
```

`engine()` resolves the realm **once** and hands back a synchronous open, for a host that opens many databases:

```js
import { sqliteEngine } from "@akaoio/udb"
const open = await sqliteEngine()               // once, at module scope
const db = open({ path: "data/chart/eth.db" })  // synchronous, per symbol, lazily
```

That split is not a convenience: a store that opens a database per symbol from inside synchronous readers cannot await, and making it await moves one `await` at the top into an `await` at every call site beneath it — measured in akao, ~250 call sites in 12 files under one lazy open.

The door is **async** because it imports only the engine this realm can run: `node.js` imports `node:sqlite` at its top level, and a static import of that would take the whole chain down in a browser. A caller that knows its realm can import `nodeDatabase` from `src/sqlite/node.js` directly and keep a synchronous open.

One contract: `exec` `all` `get` `run` `batch(queries)` `transaction(fn)` `close`. Two engines run the statements themselves (`local: true`) and offer two more that cannot cross a transport — `prepare(sql)` → `{ run, get, all, finalize }` and `sync` → `{ exec, all, get, run, transaction }`, both synchronous. The page's handle forwards the async verbs and refuses those two BY NAME.

Measured on one box, 20 000 writes + 20 000 reads: held statements **115.7 ms**, the same work through the async `sql`-string verbs **251.3 ms (+117 %)**, and with reads gathered into one synchronous transaction **152.5 ms (+32 %)**. A door without `prepare` makes the slow number the only option for code whose whole job is a loop.

- **`transaction(fn)` hands `fn` a SYNCHRONOUS handle and refuses a promise.** An `await` between BEGIN and COMMIT gives the event loop away with the transaction open, and anything else reaching that connection lands inside it — a write lost or rolled back, with nothing in a log to say so. Across a transport a function cannot travel at all, so the remote handle throws by name and points at `batch`, the same atomicity expressed as data.
- **Several statements with parameters are refused.** Measured on Node v24.21: `prepare("CREATE TABLE a(x); CREATE TABLE b(y)").all()` creates only `a`, with no error. The door turns that silent loss into a refusal.
- **Rows carry an ordinary prototype in both engines** — `node:sqlite` answers null-prototype objects, so the door normalises them; a row type that depends on the realm is a difference this door exists to remove.
- **Pragmas on Node are the caller's.** Whoever owns the directory states its durability policy; the engine only knows how to run SQL. The browser engine states three of its own (WAL, `synchronous = NORMAL`, manual checkpointing) because OPFS has no second writer and every fsync is felt.
- **The WASM build is this package's dependency, but a host never declares it**: npm installs it transitively. A page has no module resolution, so `WASM_ASSETS` declares which files a host's builder must copy next to its worker, and the host passes the initialised module in.

## Filter language

One meaning, two backends: `match(doc, filter)` (in-process matcher) and `compile(filter)` (SQL WHERE over `json_extract`). Ops `$eq $ne $gt $gte $lt $lte $in $nin`, combinators `&`/`|`, dot paths, honest null-vs-missing.

## One call at a time, per database

```js
import { CallQueue } from "@akaoio/udb"

const queue = new CallQueue({ send: (method, params, callback) => port.postMessage(...), defaultTimeout: 10000 })
await queue.call("all", { sql: "SELECT 1" })
```

The remote engine forwards every verb to whatever holds the real database — a worker, a socket, another process — and something has to serialise those calls and notice when an answer never comes. **Per database, not per realm**, and that is measured rather than chosen: a host arrived here with one queue for its whole process and paid twice — head-of-line blocking (a slow query on one database delayed every other) and a watchdog that flushed the ENTIRE shared line when one database timed out, killing every sibling's in-flight work.

The transport is injected and the queue never learns what carries its calls, which is what makes all of that testable with no worker, no socket and no database.

## Replication — a directory of databases that survives the machine

```js
import { replica } from "@akaoio/udb/src/replica/index.js"   // a server reaches it directly: it imports node:child_process
import { REPLICATED_PRAGMAS } from "@akaoio/udb"             // safe in every realm: data, no imports

const db = await sqlite({ path: "data/alerts.db", pragmas: REPLICATED_PRAGMAS })

replica({
    name: "markets",
    dir: "data",
    binary: "./tools/litestream",                 // or null, and it looks
    replicas: (id) => [{ type: "s3", bucket: "backups", path: `markets/${id}`, endpoint: process.env.S3_ENDPOINT, region: "auto" }]
})
```

Litestream ships each database's WAL continuously, so the loss window is one sync rather than one backup cycle. The reason this is a module and not a line of shell: **Litestream has no glob** — a config naming `data/*.db` replicates one database literally called `*.db` (measured, 0.5.16). A directory that grows a file on demand needs its config generated from the directory and regenerated when the set changes, and Litestream does not reload config, so that means restarting it.

`replicas(id)` is a **port**, not a table of backends: UDB places the entries the host answers with, so any backend Litestream supports — s3, gcs, abs, sftp, file, whatever lands next — works with nothing here to update. Per database, never per directory: two databases shipping to one prefix overwrite each other's generations, and it surfaces only when somebody restores.

`REPLICATED_PRAGMAS` is the other half and it is not taste. A replicator is not a reader: Litestream creates its own tables inside the database and takes the write lock to do it, and `node:sqlite` opens with `busy_timeout = 0`. Measured 2026-08-31 while one writer inserted for 20 s: **3 303 of 57 375 writes threw (5.8 %)** at `busy_timeout = 0`, and **0 of 54 170** at 5 s.

Credentials are refused rather than written — Litestream reads them from the environment, and a config file is a thing people paste into issues. A missing binary turns replication off **loudly** and never takes the host process down with it.

## Bytes: bring your own driver, or use ours

```js
import { driver, checkDriver } from "@akaoio/udb"

const bytes = await driver({ root: "data" })      // node:fs on a server, OPFS in a browser
await checkDriver(myOwnDriver)                    // does yours keep the same promises?
```

`driver` is a port, so a host with its own file layer keeps injecting that. What changed is that having one is no longer a precondition: most hosts want documents in a directory, and writing the same four methods against `node:fs` is work every one of them was doing identically — this package had even written it once, in its own test fixtures, which is the clearest evidence it belonged here.

Both drivers also offer the **six verbs beyond the port** — `list exists isDir mkdir move copyFile` — because a host with a file layer of its own needs them and was writing them over this same backend. The port still demands four: a package may ship more than it asks for, and asking for ten would impose a law it does not live by. `checkFileDoor(driver)` is the extra promise, and a driver that answers only the four is still conformant.

OPFS has no `stat` and no `rename`, which is where those meanings are least obvious: `isDir` is answered by TRYING to open the name as a directory (it THROWS on a file rather than answering false), `exists` by looking among the parent's keys, and `move` is a copy followed by a remove.

The browser one carries a detail no host should rediscover: **two writes to one path at the same time throw `NoModificationAllowedError`**, because OPFS refuses a second writable while one is open. A driver without a per-path queue passes every test and breaks the day the app gets busy.

`checkDriver(driver)` is the other half of the contract. The registry checks SHAPE — four methods and a scope — and shape is not meaning: a driver whose `readBytes` throws on a miss has every method and still breaks the statics engine, which asks "is there an at-rest copy" on every read. Those meanings used to live only in what the engines happened to expect, so every host discovered them by breaking. Now they are assertions, exported, and a host runs them against its own driver in its own suite.

## Files: the door, and the tier ladder under it

```js
import { fs } from "@akaoio/udb"

const door = fs({ driver, origin: "https://example.com", parse, stringify, tier })

await door.write(["configs", "app.json"], { theme: "dark" })   // throws if it did not happen
const configs = await door.load(["configs", "app.json"])       // origin → store → tier
await door.copy(["from"], ["to"], { skip })                    // → { copied, skipped }
await door.dir(["src"], /\.js$/)                               // relative paths that match
```

`load` was the one port this package stated the LAW of — `checkLoad` names four promises and no host — while shipping no body for it. Every other port with a conformance kit has one here, so that asymmetry was a law with its body in the host's repository: the shape the seam exists to end.

**The ORDER is this package's to state, because it owns the tier above it.** `statics` re-hashes the at-rest copy and calls a loader only once that copy is missing or stale, so reading the store FIRST here would hand back exactly the bytes just rejected — an unvalidated cache below a validated one, failing silently.

| rung | when |
|---|---|
| the origin | whenever `urlOf(path)` answers a URL. What it serves is written through to the store as it lands, and a `{fresh:true}` **404 evicts** the at-rest copy — otherwise a file deleted at the source lives in the store forever |
| the store | the last net, offline. Skipped entirely under `{fresh:true}`: fresh means "not from a copy", and answering from one makes the disagreement permanent |
| `tier(path)` | one more source a host has — a swarm, a peer, a mirror. Exactly one, because a ladder with an open-ended list of tiers has an order nobody can state |

`urlOf`/`origin` and `parse`/`stringify` are a **spelling** and a **vocabulary**, which is why they are parameters: this package paid once for owning a host's naming (it built the address of a deployed hash by swapping a file's extension for `.hash`). With no `parse` it reads JSON or text, which is what "no vocabulary of my own" means. A path with no origin means the store IS the origin — so nothing here asks which realm it is in.

**A QUESTION answers; a COMMAND throws.** `exists` `isDir` `list` `load` `find` never throw, and an absent path is an ordinary answer. `write` `remove` `move` `ensure` `copy` `download` fail loudly, wrapped once, naming the verb and the path — `copy` at the LEAF that failed, not the root of the walk. The first draft did the opposite, and akao had already paid for that twice: a `copy` that logged and answered `undefined` made every vendor step of a build incapable of failing, and a `remove` that caught a malformed-path `TypeError` and answered `false` reported a bug in the caller as a fact about the disk. The optional case is a GUARD at the call site, never a silence inside the door.

`copyTree` / `matches` / `find` are also exported on their own, next to `walk`, for a host that wants the traversal without the door.

## Documents in a tree: the chain-store

```js
import { driver, chainStore, checkStore, createDB, collections } from "@akaoio/udb"

const store = chainStore({ driver: await driver({ root: "data" }) })

const DB = createDB({ statics, lives: { store }, collections: collections({ kv: () => store }) })
await checkStore(myOwnStore)     // does yours answer what the doors above ask?
```

Two ports want a chain-store — `lives.store` and the `kv` engine of `collections` — and this package shipped neither, so "bring a chain-store" was asked of every host on top of "bring a byte driver".

It persists **through the driver port**, so one implementation serves both realms: the realm question was already answered once by `driver()`, and answering it again here — an IndexedDB engine beside a file engine — would be two more things to keep in step and two more places for "what does a miss mean" to drift.

**One document per file.** A document at `["a","b"]` is the bytes at `a/b.json`, and the children of `["a","b"]` live in `a/b/` — a node may hold a value and have children at the same time. The engine this replaces kept a collection in one JSON file and rewrote the whole thing on every save, which is fine until it is not, and is silently quadratic in a directory that grows.

`checkStore(store)` is the meaning half, and the gap it closes is wider than the driver's: the registry says a store has `get` and `del`, while the doors above chain `get(a).get(b)`, pass arrays to `get`, read `once()`, enumerate with `map(callback)` and key their rows off `path.at(-1)`. None of that was written anywhere, so a host wiring its own store discovered it by having a collection come back empty.

## The seam: one law, one registry

**A capability has ONE owner. The other side touches it only through a port, and when a host must influence an owned capability that influence arrives as PARAMETERS — never as a second half of the implementation.** The owner is the side that can state the capability's law without naming the other side: *how to run SQL in this realm* is statable without naming any host, so the engine is UDB's; *which bucket these bytes replicate to* names one deployment, so it is the host's and reaches UDB as an argument.

Every port — its name, its shape, which capability it serves and who implements it — lives in **`src/contract.js`**, and the doors ask that table rather than spelling their own lists. There is deliberately no copy of it here: a list in prose is a second home, and it goes stale exactly when a port is added.

```bash
npm run ports          # prints the registry, from the registry
```

A door may declare the `realm` it belongs to — replication supervises a process, so a browser wires nothing for it and a host serving both realms asks rather than keeping its own list of what to skip. Each port is checked **at wiring**, not at the first read, and a refusal names the port, the door that needed it, and what it is for. The method lists are exactly what this package **calls** — no wider. akao's own byte driver has ten methods because its file door needs them; demanding ten here would impose a law this package does not live by, and the next host would implement six methods to satisfy a contract nobody reads. Two contracts, two homes, because they really are two different claims.

## The host injects what only it can know

UDB imports nothing from its host — the SQLite engine it now carries is reached through parameters too (the module, or a transport). What a host still wires in is everything that is about THIS host rather than about a realm: how bytes are loaded and stored, what a content address is, how a realm announces a write.

```js
import { createDB, statics, collections } from "@akaoio/udb"

const DB = createDB({
    statics: statics({
        load,        // (path, {fresh, quiet}) → data — yours, or `loader()` below
        driver,      // { scope, readBytes, writeBytes, remove, entries } — OPFS, node:fs, anything
        infohash,    // (bytes, name) → { v1 } — the content address your build publishes
        hashes,      // (path) → { ok, status, hash } — the hash your ORIGIN states for that path
        metadata,    // (name) → true when the file describes others (your sidecars)
        browser, dev
    }),
    lives: { store },                      // a chain-store (get/put/del/once/on/map + ready)
    collections: collections({ sql, kv })  // whichever you inject is the engine — sql wins if both; kv: chain-store
})
```

Reactivity (`on`, `find().on`) is **realm-local by design** — cross-realm fan-out is the host's transport concern (`DB.announce`).

### What `infohash` is, and what it is deliberately NOT

A **content address the host chose** — UDB never computes one and never says what it should be. The statics engine calls `infohash(bytes, name)` once, compares the `v1` it gets with the hash the origin published, and that is the whole of its interest: any addressing scheme works as long as the host uses the SAME one when publishing.

It stays a parameter on purpose. akao's is BEP 3 (BitTorrent v1), because akao carries its tree over a swarm and the infohash IS the torrent's identity — a fact about that host's transport, not about a data door. Moving BEP 3 in here would make a universal door drag BitTorrent behind it, and a host that addresses content by SHA-256 would inherit a law it does not use. If a second host ever needs BEP 3 too, its home is a package of its own, not this one.

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
