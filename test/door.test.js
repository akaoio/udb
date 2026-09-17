import { test } from "node:test"
import assert from "node:assert/strict"
import { createDB, collections, statics } from "../src/index.js"
import { memoryStore } from "./stubs.js"
import { sqlite, diskRoot, diskDriver, contentHash, encode } from "./real.js"
import { PORTS, NEEDS, conform } from "../src/contract.js"
import { detectEnvironment } from "../src/env.js"

// The door wired to REAL parts wherever a real part exists dependency-free:
// statics on a real filesystem with a real digest, the browser collection
// engine on a real SQLite (node:sqlite). The kv chain-store remains the one
// documented CONTRACT double — its real implementation belongs to the host
// (akao pins it against real IndexedDB in its conformance tier).
function makeDB({ engine = "kv" } = {}) {
    const lives = memoryStore()
    const driver = diskDriver(diskRoot())
    // `hashes` and `metadata` are the two answers the HOST owes the statics
    // engine. Here the host is the smallest honest one: a table of what the
    // origin publishes, and a host that names no sidecars.
    const published = new Map()
    const DB = createDB({
        statics: statics({
            load: async () => undefined,
            driver,
            infohash: contentHash,
            hashes: async (path) => {
                const hash = published.get(path.join("/"))
                return hash ? { ok: true, status: 200, hash } : { ok: false, status: 404, hash: undefined }
            },
            metadata: () => false,
            browser: false,
            dev: false
        }),
        lives: { store: lives },
        // The host injects ONE engine, and that is what picks it — no realm flag.
        collections: collections(engine === "sql" ? { sql: async () => sqlite() } : { kv: async () => memoryStore() })
    })
    return { DB, lives, driver, published }
}

test("a lives store of the wrong shape is refused at createDB, by name", () => {
    // Without this, a store missing `del` answered DB.wipe() with a TypeError
    // from inside the package, and a store missing `get` failed on the first read.
    assert.throws(() => createDB({ statics: {}, lives: { store: {} }, collections: () => ({}) }), /lives.store injected into createDB\(\) is missing get\(\), del\(\)/)
    assert.throws(() => createDB({ statics: {}, lives: {}, collections: () => ({}) }), /needs a lives.store object/)
})

test("grammar: array key is sugar for chaining", () => {
    const { DB } = makeDB()
    const a = DB.get(["statics", "x", "y.json"])
    const b = DB.get("statics").get("x").get("y.json")
    assert.deepEqual(a.path, b.path)
    assert.equal(a.mount.name, b.mount.name)
})

test("grammar: a verb a mount does not offer throws by NAME", () => {
    const { DB } = makeDB()
    assert.throws(() => DB.get("statics").get("x.json").put({}), /put/)
    assert.throws(() => DB.get("lives").get("x").peek(), /peek/)
    assert.throws(() => DB.get("lives").get("pools").find({}), /find/)
})

test("grammar: statics root is not readable; local holds flat keys", () => {
    const { DB } = makeDB()
    assert.throws(() => DB.get("statics").once())
    assert.throws(() => DB.get("local").get("a").get("b").peek())
})

test("lives: put persists AND announces the same-path fragment", async () => {
    const { DB } = makeDB()
    const announced = []
    DB.announce = (fragment) => announced.push(fragment)
    await DB.get("lives").get("pools").get("1").get("0xA").put({ rate: 3 })
    assert.deepEqual(await DB.get("lives").get("pools").get("1").get("0xA").once(), { rate: 3 })
    assert.deepEqual(announced, [{ pools: { 1: { "0xA": { rate: 3 } } } }])
})

test("lives: without a registered transport, put still persists", async () => {
    const { DB } = makeDB()
    await DB.get("lives").get("solo").put(1)
    assert.equal(await DB.get("lives").get("solo").once(), 1)
})

test("local: peek/put/del round-trip (memo-only without localStorage)", () => {
    const { DB } = makeDB()
    DB.get("local").get("__UDB_test").put({ id: 9 })
    assert.deepEqual(DB.get("local").get("__UDB_test").peek(), { id: 9 })
    DB.get("local").get("__UDB_test").del()
    assert.equal(DB.get("local").get("__UDB_test").peek(), undefined)
})

// ── The collection contract, on BOTH engines ────────────────────────────────
// One body of assertions; the browser run hits a REAL SQLite, the node run
// hits the kv contract double. Parity here is the same law the filter
// conformance pins — engines differ, meaning may not.
for (const [label, engine] of [
    ["REAL SQLite engine", "sql"],
    ["kv contract engine", "kv"]
]) {
    test(`collections (${label}): CRUD + find ordered by _id`, async () => {
        const { DB } = makeDB({ engine })
        assert.throws(() => DB.get("Swaps!"), /not a valid collection name/)
        assert.throws(() => DB.get("c1").get("x").put(42), /documents/)
        await DB.get("c1").get("b").put({ n: 2 })
        await DB.get("c1").get("a").put({ n: 1 })
        assert.deepEqual(
            (await DB.get("c1").find({})).map((d) => d.n),
            [1, 2]
        )
        assert.deepEqual(await DB.get("c1").get("a").once(), { n: 1 })
        await DB.get("c1").get("a").del()
        assert.equal(await DB.get("c1").get("a").once(), undefined)
    })

    test(`collections (${label}): find().on() delivers now and after every settled write`, async () => {
        const { DB } = makeDB({ engine })
        await DB.get("c2").get("a").put({ kind: "swap", n: 1 })
        const deliveries = []
        const off = await DB.get("c2")
            .find({ kind: "swap" })
            .on((docs) => deliveries.push(docs.map((d) => d.n)))
        assert.deepEqual(deliveries, [[1]])
        await DB.get("c2").get("b").put({ kind: "swap", n: 2 })
        assert.deepEqual(deliveries.at(-1), [1, 2])
        await DB.get("c2").get("a").del()
        assert.deepEqual(deliveries.at(-1), [2])
        off()
        await DB.get("c2").get("c").put({ kind: "swap", n: 3 })
        assert.deepEqual(deliveries.at(-1), [2]) // unsubscribed
    })
}

test("statics through the door: mount re-prefixes, engine serves validated bytes off a real disk", async () => {
    const { DB, driver, published } = makeDB()
    const body = encode(JSON.stringify({ v: 7 }))
    await driver.writeBytes(["statics", "x.json"], body)
    published.set("statics/x.json", (await contentHash(body, "x.json")).v1)
    assert.deepEqual(await DB.get("statics").get("x.json").once(), { v: 7 })
})

test("wipe clears the door's stores; ready settles", async () => {
    const { DB, lives } = makeDB()
    await DB.get("lives").get("x").put(1)
    await DB.ready
    await DB.wipe()
    assert.equal(await DB.get("lives").get("x").once(), undefined)
    assert.equal(lives._data.size, 0)
})

test("the port registry is the one home: every port a door needs is declared", () => {
    // Self-consistency rather than a copy of the list: this goes red the day a
    // door asks for a port nobody declared, which is the shape a second home
    // would arrive in.
    for (const [who, needs] of Object.entries(NEEDS)) {
        for (const name of [...(needs.required ?? []), ...(needs.oneOf ?? []).flat()]) {
            assert.ok(PORTS[name], `${who} needs a port "${name}" that PORTS does not declare`)
            assert.ok(PORTS[name].serves, `port "${name}" does not say what capability it serves`)
            assert.ok(PORTS[name].by, `port "${name}" does not say WHO implements it — that is the whole question the registry exists to answer`)
        }
        for (const name of Object.keys(needs.as ?? {})) assert.ok(PORTS[name], `${who} renames a port "${name}" that PORTS does not declare`)
    }
})

test("a door the registry does not know is refused — the seam cannot grow a second home", () => {
    assert.throws(() => conform("someOtherDoor()", {}), /does not know that door/)
})

test("collections() with NO engine is refused AT WIRING, not at the first collection", () => {
    // It used to surface from `collectionMount(name)` — a different moment and a
    // different stack from the mistake, and only if a collection was ever asked
    // for. The message still says which engine to inject and that the choice is
    // what decides.
    assert.throws(() => collections({}), /needs one of sql \(.*\) or kv \(/)
})

test("collections() with an engine of the wrong SHAPE is refused by name, at wiring", () => {
    // Before the registry this door checked nothing at all: a `sql` that was not
    // a function reached `sqlEngine` and threw `sql is not a function` from
    // inside this package, with the cause in the host's wiring.
    assert.throws(() => collections({ sql: "sqlite.db" }), /needs sql to be a function/)
    assert.throws(() => collections({ kv: {} }), /needs kv to be a function/)
})

test("a door may say which realm it belongs to, and a host can ASK", () => {
    // Replication supervises a process; a browser realm wires nothing for it.
    // Without this field a host serving both realms would keep its own list of
    // doors to skip — the second home this registry exists to prevent. A door
    // with no `realm` belongs to every realm, which is most of them.
    assert.equal(NEEDS["replica()"].realm, "node")
    for (const [door, needs] of Object.entries(NEEDS)) {
        if (!needs.realm) continue
        assert.ok(["node", "browser"].includes(needs.realm), `${door} claims realm "${needs.realm}", which is not one this package knows`)
    }
})

test("which realm this is, is ANSWERED by this package — a host should never write it twice", () => {
    // akao held these same two conditions, byte for byte, in its own
    // `Utils/environment.js`: same function name, same md5. A host that needs the
    // answer and finds no export has one option left, and it is the wrong one.
    assert.equal(typeof detectEnvironment, "function")
    assert.deepEqual(detectEnvironment({ process: { versions: { node: "24" } } }), { NODE: true, BROWSER: false })
    assert.deepEqual(detectEnvironment({ location: { origin: "https://example.test" } }), { NODE: false, BROWSER: true })
    // A worker: an origin and no process, which is the case the naive check gets
    // wrong by asking for `window`.
    assert.deepEqual(detectEnvironment({ location: { origin: "https://example.test" }, self: {} }), { NODE: false, BROWSER: true })
    assert.deepEqual(detectEnvironment({}), { NODE: false, BROWSER: false }, "neither is an honest answer — some scope is neither, and guessing one would be a claim nobody measured")
})

test("an OPTIONAL port may be absent, and is CHECKED when it is there", async () => {
    // The registry could not SAY this until `fs()` existed, and the gap was found
    // from OUTSIDE: a host walking `NEEDS` saw every optional port it injected as a
    // port answered into the void, because only `required` was written down. A
    // registry that describes the doors it had the day it was written is the drift a
    // registry exists to prevent — so it now says `optional`, and `npm run ports`
    // prints those too, because a printout narrower than its table is the same
    // defect one layer out.
    const { conform } = await import("../src/contract.js")
    const driver = { scope: "s", readBytes: () => {}, writeBytes: () => {}, remove: () => {}, entries: () => {} }
    assert.doesNotThrow(() => conform("fs()", { driver }), "absent is allowed")
    assert.doesNotThrow(() => conform("fs()", { driver, parse: () => {}, tier: () => {} }), "present and right is allowed")
    // "Optional" means absent is allowed — never that a wrong shape is. A host that
    // passes a string where a function belongs must hear about it at wiring rather
    // than from inside an engine three calls later.
    assert.throws(() => conform("fs()", { driver, parse: "not a function" }), /parse/)
})
