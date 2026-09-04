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
