import { test } from "node:test"
import assert from "node:assert/strict"

/**
 * The small-config store, and the verb that was missing from it.
 *
 * A fake Storage is installed BEFORE the module loads, because `local.js` reads
 * `globalThis.localStorage` through a helper on every call but installs its
 * cross-tab listener once, at import. The fake is the full Storage shape — the
 * one thing `clear()` needs beyond get/set/remove is `key(index)`, which is the
 * only way to enumerate what earlier sessions wrote.
 */
const data = new Map()
globalThis.localStorage = {
    get length() {
        return data.size
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear()
}

const { peek, put, del, clear, on, Local } = await import("../src/local.js")

test("the door carries five verbs, and `clear` is one of them", () => {
    // A host offering a factory reset had no correct way to do it: the door could
    // remove one key at a time and nothing else.
    assert.deepEqual(Object.keys(Local).sort(), ["clear", "del", "on", "peek", "put"])
})

test("clear() empties the memo, not just the storage — the bug it exists for", () => {
    put("locale", "vi")
    assert.equal(peek("locale"), "vi")
    clear()
    // Before this verb a host called localStorage.clear() itself and THIS is what
    // came back: "vi", from a memo no event could reach. Measured in akao.
    assert.equal(peek("locale"), undefined, "a cleared key must not survive in RAM")
    assert.equal(globalThis.localStorage.getItem("locale"), null)
})

test("it counts keys from BOTH sides, including what this process never read", () => {
    clear()
    put("theme", "dark") // memo + storage
    globalThis.localStorage.setItem("fiat", '"VND"') // an earlier session's key
    assert.equal(clear(), 2, "both the touched key and the untouched one")
    assert.equal(peek("fiat"), undefined)
})

test("subscribers hear a clear as their key becoming undefined", () => {
    clear()
    const heard = []
    const off = on("locale", (value) => heard.push(value))
    put("locale", "en")
    clear()
    off()
    assert.deepEqual(heard, ["en", undefined], "the clear is news, the same way del is")
})

test("a subscriber to a key this process never READ is still told", () => {
    clear()
    globalThis.localStorage.setItem("referrer", '"x"')
    const heard = []
    const off = on("referrer", (value) => heard.push(value))
    clear()
    off()
    assert.deepEqual(heard, [undefined], "enumerating storage is what makes this possible")
})

test("and a callback reading back during the clear sees the store already empty", () => {
    clear()
    put("locale", "vi")
    let seen = "not called"
    const off = on("locale", () => {
        seen = peek("locale")
    })
    clear()
    off()
    assert.equal(seen, undefined, "notification comes after the emptying, never during")
})

test("no storage at all (plain Node) is memo-only, and clear() still works", () => {
    const held = globalThis.localStorage
    try {
        put("locale", "vi")
        delete globalThis.localStorage
        assert.equal(peek("locale"), "vi", "the memo answers where there is no platform")
        assert.equal(clear(), 1)
        assert.equal(peek("locale"), undefined)
    } finally {
        globalThis.localStorage = held
        data.clear()
    }
})

test("a partial shim with no key() still empties both sides", () => {
    // This package assumes only get/set/remove elsewhere, so a host may hand over
    // that much. Then never-read keys go unannounced — the smallest possible loss,
    // and better than refusing to reset at all.
    const held = globalThis.localStorage
    const shim = new Map()
    try {
        globalThis.localStorage = {
            getItem: (key) => (shim.has(key) ? shim.get(key) : null),
            setItem: (key, value) => shim.set(key, String(value)),
            removeItem: (key) => shim.delete(key),
            clear: () => shim.clear()
        }
        put("locale", "vi")
        assert.equal(clear(), 1)
        assert.equal(shim.size, 0, "the storage is emptied through its own clear()")
        assert.equal(peek("locale"), undefined)
    } finally {
        globalThis.localStorage = held
        data.clear()
    }
})

test("a storage that REFUSES to clear is reported, never fatal", () => {
    const held = globalThis.localStorage
    const warnings = []
    const warn = console.warn
    try {
        globalThis.localStorage = {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
            clear: () => {
                throw new Error("SecurityError")
            }
        }
        console.warn = (...args) => warnings.push(args.join(" "))
        put("locale", "vi")
        assert.doesNotThrow(() => clear())
        assert.equal(peek("locale"), undefined, "the memo is emptied regardless")
        assert.equal(warnings.length, 1, "exactly the failed clear spoke — this shim's setItem succeeds")
        assert.match(warnings[0], /could not clear storage/)
    } finally {
        console.warn = warn
        globalThis.localStorage = held
        data.clear()
    }
})

test("del still says undefined for one key without touching the rest", () => {
    clear()
    put("locale", "vi")
    put("theme", "dark")
    del("locale")
    assert.equal(peek("locale"), undefined)
    assert.equal(peek("theme"), "dark")
})

// ── The four cases this file already had, kept verbatim in meaning ──────────
// They measure the ENCODING and the read discipline, which `clear` says nothing
// about: JSON on write, a legacy raw string healing itself, no write-on-read, and
// a subscription that actually unsubscribes. Each one was written for a real
// value this store holds (theme, locale, fiat, referrer).

test("put persists JSON; peek reads through the memo", () => {
    clear()
    put("theme", { code: "dark" })
    assert.equal(data.get("theme"), '{"code":"dark"}')
    assert.deepEqual(peek("theme"), { code: "dark" })
})

test("a legacy raw string decodes as itself and the next put heals it", () => {
    clear()
    data.set("locale", "vi") // written before JSON encoding existed
    assert.equal(peek("locale"), "vi")
    put("locale", "vi")
    assert.equal(data.get("locale"), '"vi"')
})

test("del leaves undefined behind, and reading never writes", () => {
    clear()
    put("fiat", "usd")
    del("fiat")
    assert.equal(peek("fiat"), undefined)
    const before = data.size
    peek("never_written")
    assert.equal(data.size, before) // no write-on-read
})

test("on() hears same-tab puts and unsubscribes cleanly", () => {
    clear()
    const heard = []
    const off = on("referrer", (value) => heard.push(value))
    put("referrer", "r1")
    off()
    put("referrer", "r2")
    assert.deepEqual(heard, ["r1"])
})
