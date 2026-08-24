import { test } from "node:test"
import assert from "node:assert/strict"
import { createDB, collections, statics } from "../src/index.js"
import { memoryStore } from "./stubs.js"
import { sqlite, diskRoot, diskDriver, contentHash, encode } from "./real.js"

// The door wired to REAL parts wherever a real part exists dependency-free:
// statics on a real filesystem with a real digest, the browser collection
// engine on a real SQLite (node:sqlite). The kv chain-store remains the one
// documented CONTRACT double — its real implementation belongs to the host
// (akao pins it against real IndexedDB in its conformance tier).
function makeDB({ browser = false } = {}) {
    const lives = memoryStore()
    const driver = diskDriver(diskRoot())
    const DB = createDB({
        statics: statics({ load: async () => undefined, driver, infohash: contentHash, browser: false, dev: false }),
        lives: { store: lives },
        collections: collections({ browser, sql: async () => sqlite(), kv: async () => memoryStore() })
    })
    return { DB, lives, driver }
}

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
for (const [label, browser] of [
    ["REAL SQLite engine", true],
    ["kv contract engine", false]
]) {
    test(`collections (${label}): CRUD + find ordered by _id`, async () => {
        const { DB } = makeDB({ browser })
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
        const { DB } = makeDB({ browser })
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
    const { DB, driver } = makeDB()
    const body = encode(JSON.stringify({ v: 7 }))
    await driver.writeBytes(["statics", "x.json"], body)
    await driver.writeBytes(["statics", "x.hash"], encode((await contentHash(body, "x.json")).v1))
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
