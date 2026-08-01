import { test } from "node:test"
import assert from "node:assert/strict"
import { statics } from "../src/statics.js"
import { memoryDriver, fakehash, encode } from "./stubs.js"

function makeEngine({ files = {}, load = async () => undefined, browser = false } = {}) {
    const driver = memoryDriver()
    for (const [key, value] of Object.entries(files)) driver._files.set(key, typeof value === "string" ? encode(value) : value)
    const calls = { fresh: 0, stale: 0 }
    const engine = statics({
        load: async (path, options = {}) => {
            if (options.fresh) calls.fresh++
            else calls.stale++
            return load(path, options)
        },
        driver,
        infohash: fakehash,
        browser,
        dev: false
    })
    return { engine, driver, calls }
}

async function withHash(body) {
    return { body, hash: (await fakehash(encode(body))).v1 }
}

test("an at-rest body proves itself and serves without the body tiers", async () => {
    const { body, hash } = await withHash('{"v":1}')
    const { engine, calls } = makeEngine({ files: { "statics/a.json": body, "statics/a.hash": hash } })
    assert.deepEqual(await engine.$prod(["statics", "a.json"]), { v: 1 })
    assert.deepEqual(await engine.$prod(["statics", "a.json"]), { v: 1 }) // RAM memo
    assert.equal(calls.fresh + calls.stale, 0)
})

test("tampered at-rest bytes fail their own proof and are refetched fresh", async () => {
    const { hash } = await withHash('{"v":1}')
    const { engine, calls } = makeEngine({
        files: { "statics/b.json": '{"v":666}', "statics/b.hash": hash },
        load: async (_p, { fresh }) => (fresh ? { v: 2 } : undefined)
    })
    assert.deepEqual(await engine.$prod(["statics", "b.json"]), { v: 2 })
    assert.equal(calls.fresh, 1)
})

test("a stale fallback is served for offline UX but never trusted as validated", async () => {
    let freshBody
    const { engine, calls } = makeEngine({
        files: { "statics/c.hash": "deadbeef" },
        load: async (_p, { fresh }) => (fresh ? freshBody : { v: 1 })
    })
    assert.deepEqual(await engine.$prod(["statics", "c.json"]), { v: 1 })
    assert.equal(calls.fresh, 1)
    // the memo holds no validated hash — the next pass MUST try fresh again
    freshBody = { v: 2 }
    assert.deepEqual(await engine.$prod(["statics", "c.json"]), { v: 2 })
    assert.equal(calls.fresh, 2)
})

test("on() hears a validated change that landed at rest from outside", async () => {
    const first = await withHash('{"v":1}')
    const { engine, driver } = makeEngine({ files: { "statics/d.json": first.body, "statics/d.hash": first.hash } })
    const deliveries = []
    const off = await engine.on(["statics", "d.json"], (data) => deliveries.push(data?.v))
    assert.deepEqual(deliveries, [1])
    // a deploy swaps body AND hash on disk — no fetch involved
    const second = await withHash('{"v":2}')
    driver._files.set("statics/d.json", encode(second.body))
    driver._files.set("statics/d.hash", encode(second.hash))
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

test("map() walks data files only, never the sidecars", async () => {
    const { body, hash } = await withHash('{"v":3}')
    const { engine } = makeEngine({
        files: { "statics/e/x.json": body, "statics/e/x.hash": hash, "statics/e/x.torrent": "d4:infoe" }
    })
    const seen = []
    const count = await engine.map(["statics"], (value, path) => seen.push([path.join("/"), value.v]))
    assert.equal(count, 1)
    assert.deepEqual(seen, [["statics/e/x.json", 3]])
})

test("a .hash request answers the current hash directly", async () => {
    const { engine } = makeEngine({ files: { "statics/f.hash": "cafebabe" } })
    assert.equal(await engine.$prod(["statics", "f.hash"]), "cafebabe")
})

test("browser 404 on the hash evicts and falls to a fresh load", async () => {
    const { engine, driver } = makeEngine({ browser: true, files: { "statics/g.json": '{"v":9}', "statics/g.hash": "stale" } })
    const savedFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 404 })
    try {
        assert.equal(await engine.$prod(["statics", "g.json"]), undefined)
        assert.equal(driver._files.has("statics/g.hash"), false) // orphan sidecar evicted
    } finally {
        globalThis.fetch = savedFetch
    }
})

test("browser offline serves what is held, unvalidated", async () => {
    const { engine } = makeEngine({ browser: true, files: { "statics/h.json": '{"v":4}' }, load: async (_p, { fresh }) => (fresh ? undefined : { v: 4 }) })
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

test("wipe clears RAM everywhere but at-rest only in the browser", async () => {
    const { body, hash } = await withHash('{"v":5}')
    const node = makeEngine({ files: { "statics/i.json": body, "statics/i.hash": hash } })
    await node.engine.$prod(["statics", "i.json"])
    await node.engine.wipe()
    assert.equal(node.driver._files.has("statics/i.json"), true) // node build untouched

    const web = makeEngine({ browser: true, files: { "statics/i.json": body } })
    await web.engine.wipe()
    assert.equal(web.driver._files.has("statics/i.json"), false)
})
