import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeDriver } from "../src/driver/node.js"
import { loader } from "../src/loader.js"
import { checkLoad } from "../src/statics/conformance.js"

/**
 * The tier ladder — the body this package owed its own `load` port.
 *
 * The origin is a function here rather than a server: what the ladder promises is
 * an ORDER and a set of write-through rules, and a real socket would measure the
 * network instead. What cannot be measured without one is stated in
 * `statics/conformance.js` and left to a host's acceptance suite.
 */
const encode = (text) => new TextEncoder().encode(text)
const disk = () => {
    const at = mkdtempSync(join(tmpdir(), "udb-loader-"))
    return { driver: nodeDriver({ root: at }), at, clean: () => rmSync(at, { recursive: true, force: true }) }
}

/** An origin that answers what the table says, and counts what was asked. */
function origin(table) {
    const asked = []
    return {
        asked,
        fetch: async (url) => {
            asked.push(url)
            const body = table[url]
            if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
            if (body === null) throw new Error("network down")
            return { ok: true, status: 200, arrayBuffer: async () => encode(body).buffer }
        }
    }
}

test("the loader this package ships passes the law this package wrote", async () => {
    // The point of the whole file: `checkLoad` states four promises for the `load`
    // port, and until now nothing here answered them. A body that fails its own
    // kit would mean the law and the implementation were written from different
    // assumptions — which is exactly what one repository owning both prevents.
    const store = disk()
    try {
        const load = loader({ driver: store.driver, urlOf: () => null })
        // The kit THROWS with every broken promise named, and answers `true` when
        // there are none — so this one line is the whole assertion.
        assert.equal(await checkLoad(load), true)
    } finally {
        store.clean()
    }
})

test("the origin is tried FIRST, and what it serves is written through", async () => {
    // Order, and the reason for it: the tier above (statics.js) only calls a
    // loader once it has ruled the at-rest copy stale, so reading the store first
    // here hands back the very bytes that were just rejected.
    const store = disk()
    try {
        await store.driver.writeBytes(["a.json"], encode('{"from":"store"}'))
        const net = origin({ "https://o/a.json": '{"from":"origin"}' })
        const load = loader({ driver: store.driver, urlOf: (path) => `https://o/${path.join("/")}`, fetch: net.fetch })
        assert.deepEqual(await load(["a.json"]), { from: "origin" }, "the origin wins over the store")
        assert.deepEqual(net.asked, ["https://o/a.json"])
        const written = new TextDecoder().decode(await store.driver.readBytes(["a.json"]))
        assert.equal(written, '{"from":"origin"}', "and it landed at rest, so the validated tier above has something to validate")
    } finally {
        store.clean()
    }
})

test("NO origin for a path means the store IS the origin — the tier is skipped", async () => {
    // A server's own disk, and the reason this is a parameter rather than a realm
    // guess: nothing here asks which realm this is.
    const store = disk()
    try {
        await store.driver.writeBytes(["a.json"], encode('{"from":"store"}'))
        const net = origin({})
        const load = loader({ driver: store.driver, urlOf: () => null, fetch: net.fetch })
        assert.deepEqual(await load(["a.json"]), { from: "store" })
        assert.deepEqual(net.asked, [], "a path with no origin must not be fetched at all")
    } finally {
        store.clean()
    }
})

test("offline: the store is the last net, and it answers", async () => {
    const store = disk()
    try {
        await store.driver.writeBytes(["a.json"], encode('{"from":"store"}'))
        const net = origin({ "https://o/a.json": null }) // throws: network down
        const load = loader({ driver: store.driver, urlOf: () => "https://o/a.json", fetch: net.fetch })
        assert.deepEqual(await load(["a.json"]), { from: "store" })
    } finally {
        store.clean()
    }
})

test("{ fresh: true } NEVER falls back to the store — that is what fresh means", async () => {
    // The failure this refuses: the tier above asks for fresh precisely because it
    // ruled the copy stale. Answering from that copy makes the disagreement
    // permanent — every read re-detects the mismatch and re-heals into the same
    // stale bytes, forever, with nothing saying so.
    const store = disk()
    try {
        await store.driver.writeBytes(["a.json"], encode('{"from":"store"}'))
        const net = origin({ "https://o/a.json": null })
        const load = loader({ driver: store.driver, urlOf: () => "https://o/a.json", fetch: net.fetch })
        assert.equal(await load(["a.json"], { fresh: true, quiet: true }), undefined)
        assert.deepEqual(await load(["a.json"]), { from: "store" }, "and the same path without fresh still reads the copy")
    } finally {
        store.clean()
    }
})

test("a fresh 404 EVICTS the at-rest copy — a file deleted at source must not live on", async () => {
    const store = disk()
    try {
        await store.driver.writeBytes(["gone.json"], encode('{"still":"here"}'))
        const net = origin({}) // everything 404s
        const load = loader({ driver: store.driver, urlOf: (path) => `https://o/${path.join("/")}`, fetch: net.fetch })
        assert.equal(await load(["gone.json"], { fresh: true, quiet: true }), undefined)
        assert.equal(await store.driver.readBytes(["gone.json"]), null, "the copy followed the original")
    } finally {
        store.clean()
    }
})

test("a 404 WITHOUT fresh leaves the copy alone and serves it", async () => {
    // The asymmetry is deliberate: only a caller that asked for fresh has been
    // told by the origin that this path is gone. An ordinary miss may be a
    // transient, and evicting on one would empty a client's store during an outage.
    const store = disk()
    try {
        await store.driver.writeBytes(["a.json"], encode('{"from":"store"}'))
        const load = loader({ driver: store.driver, urlOf: (path) => `https://o/${path.join("/")}`, fetch: origin({}).fetch })
        assert.deepEqual(await load(["a.json"]), { from: "store" })
        assert.notEqual(await store.driver.readBytes(["a.json"]), null, "still there")
    } finally {
        store.clean()
    }
})

test("the host's extra tier is asked BELOW the store, and only when both missed", async () => {
    const store = disk()
    const asked = []
    try {
        const load = loader({
            driver: store.driver,
            urlOf: () => null,
            tier: async (path) => {
                asked.push(path)
                return encode('{"from":"tier"}')
            }
        })
        assert.deepEqual(await load(["a.json"]), { from: "tier" })
        assert.deepEqual(asked, [["a.json"]])

        await store.driver.writeBytes(["b.json"], encode('{"from":"store"}'))
        assert.deepEqual(await load(["b.json"]), { from: "store" })
        assert.equal(asked.length, 1, "the tier is not asked when the store answered")
    } finally {
        store.clean()
    }
})

test("the host's vocabulary decides what bytes MEAN — parse is its answer", async () => {
    const store = disk()
    try {
        await store.driver.writeBytes(["a.yaml"], encode("key: value"))
        const load = loader({
            driver: store.driver,
            urlOf: () => null,
            parse: (bytes, name) => (name.endsWith(".yaml") ? { parsedBy: "the host", raw: new TextDecoder().decode(bytes) } : JSON.parse(new TextDecoder().decode(bytes)))
        })
        assert.deepEqual(await load(["a.yaml"]), { parsedBy: "the host", raw: "key: value" })
    } finally {
        store.clean()
    }
})

test("the default vocabulary is JSON or text, and bytes that are not text stay bytes", async () => {
    const store = disk()
    try {
        await store.driver.writeBytes(["a.json"], encode('{"a":1}'))
        await store.driver.writeBytes(["a.txt"], encode("plain"))
        await store.driver.writeBytes(["a.bin"], new Uint8Array([0xff, 0xfe, 0x00, 0x01]))
        const load = loader({ driver: store.driver, urlOf: () => null })
        assert.deepEqual(await load(["a.json"]), { a: 1 })
        assert.equal(await load(["a.txt"]), "plain")
        // A decoder that replaced these would hand a caller a document made of
        // question marks and call it text.
        assert.deepEqual(await load(["a.bin"]), new Uint8Array([0xff, 0xfe, 0x00, 0x01]))
    } finally {
        store.clean()
    }
})

test("a body that cannot be parsed is a MISS, not a crash out of a read", async () => {
    const store = disk()
    try {
        await store.driver.writeBytes(["bad.json"], encode("{ this is not json"))
        const load = loader({ driver: store.driver, urlOf: () => null })
        assert.equal(await load(["bad.json"], { quiet: true }), undefined, "half a file at rest must not throw out of once()")
    } finally {
        store.clean()
    }
})

test("it refuses a wiring with no driver, by name, at construction", () => {
    assert.throws(() => loader({ urlOf: () => null }), /driver/)
    assert.throws(() => loader({ driver: {} }), /urlOf|driver/)
})
