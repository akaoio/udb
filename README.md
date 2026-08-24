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

## Filter language

One meaning, two backends: `match(doc, filter)` (in-process matcher) and `compile(filter)` (SQL WHERE over `json_extract`). Ops `$eq $ne $gt $gte $lt $lte $in $nin`, combinators `&`/`|`, dot paths, honest null-vs-missing.

## The host injects its engines

UDB imports **nothing** from its host. Wire it:

```js
import { createDB, statics, collections } from "@akaoio/udb"

const DB = createDB({
    statics: statics({
        load,        // (path, {fresh, quiet}) → data — your tiered loader (HTTP/disk/P2P)
        driver,      // { readBytes, writeBytes, remove, entries } — OPFS, node:fs, anything
        infohash,    // (bytes, name) → { v1 } — the content address your build publishes
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
