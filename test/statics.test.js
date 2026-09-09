import { test } from "node:test"
import assert from "node:assert/strict"
import { statics } from "../src/statics.js"
import { diskRoot, diskDriver, contentHash, encode } from "./real.js"

// The at-rest tier is a REAL filesystem here: real files under a throwaway
// root, real ENOENT, real directory listings — and the content address is a
// real SHA-1 digest of the actual bytes.
//
// The deployed hash comes from the injected `hashes` resolver, which is where
// it comes from in production too. A host publishes those hashes however it
// likes — a sidecar per file, one manifest per root, a header — and the
// TRANSPORT of that answer is the host's test to write, not this engine's.
// What this file pins is the only thing the engine decides: what to do with
// each of the three answers.
function makeEngine({ browser = false, load = async () => undefined, hashes, metadata } = {}) {
    const root = diskRoot()
    const driver = diskDriver(root)
    const calls = { fresh: 0, stale: 0, hashes: 0 }
    // The origin's published hashes, as a host would hold them.
    const published = new Map()
    const engine = statics({
        load: async (path, options = {}) => {
            if (options.fresh) calls.fresh++
            else calls.stale++
            return load(path, options)
        },
        driver,
        infohash: contentHash,
        hashes:
            hashes ??
            (async (path) => {
                calls.hashes++
                const hash = published.get(path.join("/"))
                if (hash) return { ok: true, status: 200, hash }
                return { ok: false, status: 404, hash: undefined }
            }),
        metadata: metadata ?? ((name) => name === "_.torrent" || name === "_.hashes.json"),
        browser,
        dev: false
    })
    return { engine, driver, calls, published }
}

async function deploy(driver, published, name, body) {
    const bytes = encode(body)
    await driver.writeBytes(["statics", `${name}.json`], bytes)
    published.set(`statics/${name}.json`, (await contentHash(bytes, `${name}.json`)).v1)
}

test("the engine refuses to be built without the host's two answers", () => {
    // A default would be the engine guessing one host's spelling, and the
    // guess would be invisible: every read would quietly stop validating.
    assert.throws(() => statics({ load: async () => {}, driver: {}, infohash: async () => {}, browser: false, dev: false }), /hashes/)
    assert.throws(() => statics({ load: async () => {}, driver: {}, infohash: async () => {}, hashes: async () => {}, browser: false, dev: false }), /metadata/)
})

test("an at-rest body proves itself and serves without the body tiers", async () => {
    const { engine, driver, calls, published } = makeEngine()
    await deploy(driver, published, "a", '{"v":1}')
    assert.deepEqual(await engine.$prod(["statics", "a.json"]), { v: 1 })
    assert.deepEqual(await engine.$prod(["statics", "a.json"]), { v: 1 }) // RAM memo
    assert.equal(calls.fresh + calls.stale, 0)
})

test("tampered at-rest bytes fail their own proof and are refetched fresh", async () => {
    const { engine, driver, calls, published } = makeEngine({ load: async (_p, { fresh }) => (fresh ? { v: 2 } : undefined) })
    await deploy(driver, published, "b", '{"v":1}')
    await driver.writeBytes(["statics", "b.json"], encode('{"v":666}')) // corrupt the body, keep the published hash
    assert.deepEqual(await engine.$prod(["statics", "b.json"]), { v: 2 })
    assert.equal(calls.fresh, 1)
})

test("a stale fallback is served for offline UX but never trusted as validated", async () => {
    let freshBody
    const { engine, calls, published } = makeEngine({ load: async (_p, { fresh }) => (fresh ? freshBody : { v: 1 }) })
    published.set("statics/c.json", "a".repeat(40)) // a deployed hash, no body anywhere
    assert.deepEqual(await engine.$prod(["statics", "c.json"]), { v: 1 })
    assert.equal(calls.fresh, 1)
    // the memo holds no validated hash — the next pass MUST try fresh again
    freshBody = { v: 2 }
    assert.deepEqual(await engine.$prod(["statics", "c.json"]), { v: 2 })
    assert.equal(calls.fresh, 2)
})

test("on() hears a validated change that landed at rest from outside", async () => {
    const { engine, driver, published } = makeEngine()
    await deploy(driver, published, "d", '{"v":1}')
    const deliveries = []
    const off = await engine.on(["statics", "d.json"], (data) => deliveries.push(data?.v))
    assert.deepEqual(deliveries, [1])
    await deploy(driver, published, "d", '{"v":2}') // a REAL deploy: body on disk and published hash both move
    await engine.$prod(["statics", "d.json"])
    assert.deepEqual(deliveries, [1, 2])
    await engine.$prod(["statics", "d.json"]) // same hash: no redelivery noise
    assert.deepEqual(deliveries, [1, 2])
    off()
})

test("on() rejects a directory path loudly", async () => {
    const { engine } = makeEngine()
    await assert.rejects(() => engine.on(["statics", "chains"], () => {}), /name one/)
})

test("map() walks real directories, data files only, never the host's sidecars", async () => {
    const { engine, driver, published } = makeEngine()
    await deploy(driver, published, "e/x", '{"v":3}')
    await driver.writeBytes(["statics", "e", "_.torrent"], encode("d4:infoe"))
    await driver.writeBytes(["statics", "e", "_.hashes.json"], encode("{}"))
    const seen = []
    const count = await engine.map(["statics"], (value, path) => seen.push([path.join("/"), value.v]))
    assert.equal(count, 1)
    assert.deepEqual(seen, [["statics/e/x.json", 3]])
})

test("the engine never reaches the network itself — the host answers", async () => {
    // It used to build a `.hash` URL and fetch it, in browser mode, from
    // inside this engine. A host whose hashes arrive some other way had no
    // way to stop it, and a host that renamed its sidecar got silent 404s.
    const { engine, driver, published } = makeEngine({ browser: true })
    await deploy(driver, published, "k", '{"v":7}')
    const savedFetch = globalThis.fetch
    globalThis.fetch = async () => {
        throw new Error("engine must not fetch")
    }
    try {
        assert.deepEqual(await engine.$prod(["statics", "k.json"]), { v: 7 })
    } finally {
        globalThis.fetch = savedFetch
    }
})

test("the origin states nothing for a path: serve unvalidated, hold no validated memo", async () => {
    const { engine, driver, calls } = makeEngine({ browser: true, load: async (_p, { fresh }) => (fresh ? { v: 9 } : undefined) })
    await driver.writeBytes(["statics", "g.json"], encode('{"v":9}'))
    // nothing published for g.json → the resolver answers 404
    assert.deepEqual(await engine.$prod(["statics", "g.json"]), { v: 9 })
    assert.equal(calls.fresh, 1)
    assert.deepEqual(await engine.$prod(["statics", "g.json"]), { v: 9 })
    assert.equal(calls.fresh, 2, "an unvalidated body must never satisfy the fast path")
})

test("offline serves what is held, unvalidated", async () => {
    const { engine, driver } = makeEngine({
        browser: true,
        load: async (_p, { fresh }) => (fresh ? undefined : { v: 4 }),
        hashes: async () => ({ ok: false, status: null, hash: undefined })
    })
    await driver.writeBytes(["statics", "h.json"], encode('{"v":4}'))
    assert.deepEqual(await engine.$prod(["statics", "h.json"]), { v: 4 })
})

// ── One engine, a store that MOVES under it (akao #705) ─────────────────
//
// The engine is handed a driver, a loader and a hash resolver; the STORE
// those address is the host's, and a host may repoint it inside one realm —
// a node suite staging build roots, a builder walking site after site. The
// engine is told nothing when that happens, so anything it remembers has to
// re-earn the right to answer.
//
// `ok` and 404 are safe by construction and were never the question: `ok`
// compares the held hash against the deployed one, so another store's body
// simply misses, and 404 evicts. The tests below pin the third answer, where
// there is no hash to compare with and only the tier ORDER decides.
function movingEngine({ trees, load, hashes }) {
    const roots = Object.fromEntries(trees.map((tree) => [tree, diskRoot()]))
    const state = { tree: trees[0] }
    const at = (tree) => diskDriver(roots[tree])
    const driver = {
        readBytes: (path) => at(state.tree).readBytes(path),
        writeBytes: (path, bytes) => at(state.tree).writeBytes(path, bytes),
        remove: (path) => at(state.tree).remove(path),
        entries: (path) => at(state.tree).entries(path)
    }
    const engine = statics({
        // The host's tiered loader, in the shape akao's FS.load really has:
        // it can reach the at-rest bytes itself. That detail is what makes
        // this a reproduction rather than a different bug — with a loader
        // that answers nothing, the offline branch memoized nothing and the
        // stale read could not even occur.
        load:
            load ??
            (async (path) => {
                const bytes = await driver.readBytes(path)
                return bytes?.length ? JSON.parse(new TextDecoder().decode(bytes)) : undefined
            }),
        driver,
        infohash: contentHash,
        hashes: hashes ?? (async () => ({ ok: false, status: null, hash: undefined })),
        metadata: (name) => name === "_.torrent" || name === "_.hashes.json",
        browser: false,
        dev: false
    })
    return { engine, driver, at, state }
}

test("offline reads the store, never a memo describing a store since moved", async () => {
    const { engine, at, state } = movingEngine({ trees: ["A", "B"] })
    for (const tree of ["A", "B"]) await at(tree).writeBytes(["statics", "x.json"], encode(JSON.stringify({ tree })))

    state.tree = "A"
    assert.deepEqual(await engine.$prod(["statics", "x.json"]), { tree: "A" })
    state.tree = "B"
    // Before the fix this answered { tree: "A" }: the offline branch read the
    // memo first, and no hash existed to notice the body was another store's.
    assert.deepEqual(await engine.$prod(["statics", "x.json"]), { tree: "B" })
})

test("map() reads the store's bytes, never a memo describing a store since moved", async () => {
    const { engine, at, state } = movingEngine({ trees: ["A", "B"] })
    for (const tree of ["A", "B"]) await at(tree).writeBytes(["statics", "x.json"], encode(JSON.stringify({ tree })))

    state.tree = "A"
    await engine.$prod(["statics", "x.json"]) // seed the memo from tree A
    state.tree = "B"
    const seen = []
    await engine.map(["statics"], (value) => seen.push(value?.tree))
    // walk() enumerates through the DRIVER, so a memo can only ever shadow a
    // name that is really there — which is exactly what it did.
    assert.deepEqual(seen, ["B"])
})

test("offline prefers at-rest bytes over the loader's stale answer", async () => {
    // Both tiers can answer; the order is the assertion. The store wins,
    // because the loader's stale tier is a copy of some store and the engine
    // holds nothing saying which.
    const { engine, at, state } = movingEngine({ trees: ["A"], load: async () => ({ from: "loader" }) })
    state.tree = "A"
    await at("A").writeBytes(["statics", "x.json"], encode('{"from":"at-rest"}'))
    assert.deepEqual(await engine.$prod(["statics", "x.json"]), { from: "at-rest" })
})

test("offline still serves the last held body when store and loader have nothing", async () => {
    // The offline promise survives the reordering: the memo answers last,
    // where it can only ever beat undefined.
    let reachable = true
    const { engine } = movingEngine({ trees: ["A"], load: async () => (reachable ? { v: 9 } : undefined) })
    assert.deepEqual(await engine.$prod(["statics", "x.json"]), { v: 9 })
    reachable = false
    assert.deepEqual(await engine.$prod(["statics", "x.json"]), { v: 9 })
})

test("a resolver that THROWS means 'cannot know', never 'the file is gone'", async () => {
    // The difference decides whether a client keeps serving what it holds or
    // treats every file as unhashed. Reading a crash as 404 would retire
    // validation for the whole store the first time the host's transport
    // hiccuped, and nothing would say so.
    const { engine, driver } = makeEngine({
        load: async (_p, { fresh }) => (fresh ? undefined : { v: 6 }),
        hashes: async () => {
            throw new Error("transport died")
        }
    })
    await driver.writeBytes(["statics", "m.json"], encode('{"v":6}'))
    assert.deepEqual(await engine.$prod(["statics", "m.json"]), { v: 6 })
})

test("a malformed answer is 'cannot know' too", async () => {
    for (const answer of [undefined, null, "200", { ok: true }, { ok: true, hash: "" }]) {
        const { engine, driver } = makeEngine({
            load: async (_p, { fresh }) => (fresh ? undefined : { v: 8 }),
            hashes: async () => answer
        })
        await driver.writeBytes(["statics", "n.json"], encode('{"v":8}'))
        assert.deepEqual(await engine.$prod(["statics", "n.json"]), { v: 8 }, `answer ${JSON.stringify(answer)}`)
    }
})

test("wipe clears RAM everywhere but at-rest only in the browser", async () => {
    const node = makeEngine()
    await deploy(node.driver, node.published, "j", '{"v":5}')
    await node.engine.$prod(["statics", "j.json"])
    await node.engine.wipe()
    assert.notEqual(await node.driver.readBytes(["statics", "j.json"]), null) // node build untouched

    const web = makeEngine({ browser: true })
    await web.driver.writeBytes(["statics", "j.json"], encode('{"v":5}'))
    await web.engine.wipe()
    assert.equal(await web.driver.readBytes(["statics", "j.json"]), null)
})
