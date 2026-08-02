import { test } from "node:test"
import assert from "node:assert/strict"
import { statics } from "../src/statics.js"
import { diskRoot, diskDriver, contentHash, encode } from "./real.js"

// The at-rest tier is a REAL filesystem here: real files under a throwaway
// root, real ENOENT, real directory listings — and the content address is a
// real SHA-1 digest of the actual bytes. The only simulated transport is the
// browser's fetch in the browser-mode cases, answered with REAL Response
// objects (the relative-URL contract makes genuine HTTP a browser-tier job —
// the host pins that end to end against a live server).
function makeEngine({ browser = false, load = async () => undefined } = {}) {
    const root = diskRoot()
    const driver = diskDriver(root)
    const calls = { fresh: 0, stale: 0 }
    const engine = statics({
        load: async (path, options = {}) => {
            if (options.fresh) calls.fresh++
            else calls.stale++
            return load(path, options)
        },
        driver,
        infohash: contentHash,
        browser,
        dev: false
    })
    return { engine, driver, calls }
}

async function deploy(driver, name, body) {
    const bytes = encode(body)
    await driver.writeBytes(["statics", `${name}.json`], bytes)
    await driver.writeBytes(["statics", `${name}.hash`], encode((await contentHash(bytes, `${name}.json`)).v1))
}

test("an at-rest body proves itself and serves without the body tiers", async () => {
    const { engine, driver, calls } = makeEngine()
    await deploy(driver, "a", '{"v":1}')
    assert.deepEqual(await engine.$prod(["statics", "a.json"]), { v: 1 })
    assert.deepEqual(await engine.$prod(["statics", "a.json"]), { v: 1 }) // RAM memo
    assert.equal(calls.fresh + calls.stale, 0)
})

test("tampered at-rest bytes fail their own proof and are refetched fresh", async () => {
    const { engine, driver, calls } = makeEngine({ load: async (_p, { fresh }) => (fresh ? { v: 2 } : undefined) })
    await deploy(driver, "b", '{"v":1}')
    await driver.writeBytes(["statics", "b.json"], encode('{"v":666}')) // corrupt the body, keep the hash
    assert.deepEqual(await engine.$prod(["statics", "b.json"]), { v: 2 })
    assert.equal(calls.fresh, 1)
})

test("a stale fallback is served for offline UX but never trusted as validated", async () => {
    let freshBody
    const { engine, driver, calls } = makeEngine({ load: async (_p, { fresh }) => (fresh ? freshBody : { v: 1 }) })
    await driver.writeBytes(["statics", "c.hash"], encode("a".repeat(40))) // deployed hash, no body anywhere
    assert.deepEqual(await engine.$prod(["statics", "c.json"]), { v: 1 })
    assert.equal(calls.fresh, 1)
    // the memo holds no validated hash — the next pass MUST try fresh again
    freshBody = { v: 2 }
    assert.deepEqual(await engine.$prod(["statics", "c.json"]), { v: 2 })
    assert.equal(calls.fresh, 2)
})

test("on() hears a validated change that landed at rest from outside", async () => {
    const { engine, driver } = makeEngine()
    await deploy(driver, "d", '{"v":1}')
    const deliveries = []
    const off = await engine.on(["statics", "d.json"], (data) => deliveries.push(data?.v))
    assert.deepEqual(deliveries, [1])
    await deploy(driver, "d", '{"v":2}') // a REAL deploy: body and hash swapped on disk, no fetch involved
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

test("map() walks real directories, data files only, never the sidecars", async () => {
    const { engine, driver } = makeEngine()
    await deploy(driver, "e/x", '{"v":3}')
    await driver.writeBytes(["statics", "e", "x.torrent"], encode("d4:infoe"))
    const seen = []
    const count = await engine.map(["statics"], (value, path) => seen.push([path.join("/"), value.v]))
    assert.equal(count, 1)
    assert.deepEqual(seen, [["statics/e/x.json", 3]])
})

test("a .hash request answers the current hash directly", async () => {
    const { engine, driver } = makeEngine()
    await driver.writeBytes(["statics", "f.hash"], encode("cafebabe"))
    assert.equal(await engine.$prod(["statics", "f.hash"]), "cafebabe")
})

test("browser 404 on the hash evicts and falls to a fresh load", async () => {
    const { engine, driver } = makeEngine({ browser: true })
    await driver.writeBytes(["statics", "g.json"], encode('{"v":9}'))
    await driver.writeBytes(["statics", "g.hash"], encode("stale"))
    const savedFetch = globalThis.fetch
    globalThis.fetch = async () => new Response("Not Found", { status: 404 })
    try {
        assert.equal(await engine.$prod(["statics", "g.json"]), undefined)
        assert.equal(await driver.readBytes(["statics", "g.hash"]), null) // orphan sidecar evicted
    } finally {
        globalThis.fetch = savedFetch
    }
})

test("browser offline serves what is held, unvalidated", async () => {
    const { engine, driver } = makeEngine({ browser: true, load: async (_p, { fresh }) => (fresh ? undefined : { v: 4 }) })
    await driver.writeBytes(["statics", "h.json"], encode('{"v":4}'))
    const savedFetch = globalThis.fetch
    globalThis.fetch = async () => {
        throw new Error("offline")
    }
    try {
        assert.deepEqual(await engine.$prod(["statics", "h.json"]), { v: 4 })
    } finally {
        globalThis.fetch = savedFetch
    }
})

test("browser validates against the REAL served hash body", async () => {
    // The full browser fast-path with a faithful transport: fetch answers
    // with a real Response carrying the real digest of the real bytes.
    const { engine, driver } = makeEngine({ browser: true })
    const bytes = encode('{"v":11}')
    await driver.writeBytes(["statics", "i.json"], bytes)
    const digest = (await contentHash(bytes, "i.json")).v1
    const savedFetch = globalThis.fetch
    globalThis.fetch = async (url) => (String(url).endsWith("/statics/i.hash") ? new Response(digest, { status: 200 }) : new Response("Not Found", { status: 404 }))
    try {
        assert.deepEqual(await engine.$prod(["statics", "i.json"]), { v: 11 })
    } finally {
        globalThis.fetch = savedFetch
    }
})

test("wipe clears RAM everywhere but at-rest only in the browser", async () => {
    const node = makeEngine()
    await deploy(node.driver, "j", '{"v":5}')
    await node.engine.$prod(["statics", "j.json"])
    await node.engine.wipe()
    assert.notEqual(await node.driver.readBytes(["statics", "j.json"]), null) // node build untouched

    const web = makeEngine({ browser: true })
    await web.driver.writeBytes(["statics", "j.json"], encode('{"v":5}'))
    await web.engine.wipe()
    assert.equal(await web.driver.readBytes(["statics", "j.json"]), null)
})
