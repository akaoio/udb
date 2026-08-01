import { test } from "node:test"
import assert from "node:assert/strict"

// A minimal localStorage so the engine exercises its persistence path.
const backing = new Map()
globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key)
}

const { peek, put, del, on } = await import("../src/local.js")

test("put persists JSON; peek reads through the memo", () => {
    put("theme", { code: "dark" })
    assert.equal(backing.get("theme"), '{"code":"dark"}')
    assert.deepEqual(peek("theme"), { code: "dark" })
})

test("a legacy raw string decodes as itself and the next put heals it", () => {
    backing.set("locale", "vi") // written before JSON encoding existed
    assert.equal(peek("locale"), "vi")
    put("locale", "vi")
    assert.equal(backing.get("locale"), '"vi"')
})

test("del leaves undefined behind, and reading never writes", () => {
    put("fiat", "usd")
    del("fiat")
    assert.equal(peek("fiat"), undefined)
    const before = backing.size
    peek("never_written")
    assert.equal(backing.size, before) // no write-on-read
})

test("on() hears same-tab puts and unsubscribes cleanly", () => {
    const heard = []
    const off = on("referrer", (value) => heard.push(value))
    put("referrer", "r1")
    off()
    put("referrer", "r2")
    assert.deepEqual(heard, ["r1"])
})
