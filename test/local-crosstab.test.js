import { test } from "node:test"
import assert from "node:assert/strict"

/**
 * The CROSS-TAB half of the small-config store — another window's change.
 *
 * Its own file, because the listener is installed once, at import, and only when
 * `BROWSER`. To reach it from Node the realm has to look like a browser at the
 * moment this module loads, which means `process` must be absent for exactly that
 * long — `detectEnvironment` reads it, and it reads it once.
 *
 * node:test runs each test FILE in its own process, so the swap cannot reach the
 * other suites. Nothing else in this file needs a browser.
 */
const held = globalThis.process
delete globalThis.process
globalThis.location = { origin: "https://example.test" }
// Node's globalThis has no addEventListener at all (measured: undefined), which is
// why the module registers with `?.()`. So the platform side is supplied here and
// the handler is CAPTURED — the test then delivers events by calling it, which is
// what a browser does. The event is a plain object because the three fields below
// are the entire contract this module has with the platform.
let deliver = () => {
    throw new Error("the module registered no storage listener")
}
globalThis.addEventListener = (type, handler) => {
    if (type === "storage") deliver = handler
}
const store = new Map()
globalThis.localStorage = {
    get length() {
        return store.size
    },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
}
const { peek, put, on, clear } = await import("../src/local.js")
globalThis.process = held

/** The event a browser delivers to the OTHER tabs; `key: null` means a clear. */
const storageEvent = (fields) => ({ storageArea: globalThis.localStorage, key: null, newValue: null, ...fields })

test("the listener is installed at all — the realm looked like a browser", () => {
    // If this is false every case below would pass by doing nothing, which is the
    // failure mode of testing an event nobody registered for.
    put("locale", "vi")
    deliver(storageEvent({ key: "locale", newValue: '"en"' }))
    assert.equal(peek("locale"), "en", "another tab's write reached this memo")
})

test("another tab's WRITE notifies subscribers of that key", () => {
    clear()
    const heard = []
    const off = on("theme", (value) => heard.push(value))
    deliver(storageEvent({ key: "theme", newValue: '"dark"' }))
    off()
    assert.deepEqual(heard, ["dark"])
})

test("another tab's CLEAR notifies too — the hole this file exists for", () => {
    clear()
    put("locale", "vi")
    const heard = []
    const off = on("locale", (value) => heard.push(value))
    // What actually happened over there: the SHARED storage was emptied, and only
    // then does the event arrive. Delivering the event without emptying first
    // models a browser that does not exist — and it was how this case first went
    // red against correct code.
    store.clear()
    // `key: null` is how the platform says "the whole store went".
    deliver(storageEvent({ key: null }))
    off()
    assert.deepEqual(heard, [undefined], "a clear is the largest change there is; on() promises to hear any")
    assert.equal(peek("locale"), undefined)
})

test("and a subscriber to a key THIS tab never read is told as well", () => {
    clear()
    const heard = []
    const off = on("fiat", (value) => heard.push(value))
    deliver(storageEvent({ key: null }))
    off()
    assert.deepEqual(heard, [undefined], "callbacks are enumerated, not just the memo — storage is already empty by now")
})

test("an event from a DIFFERENT storage area is not ours", () => {
    clear()
    put("locale", "vi")
    const heard = []
    const off = on("locale", (value) => heard.push(value))
    deliver(storageEvent({ key: null, storageArea: { other: true } }))
    off()
    assert.deepEqual(heard, [], "sessionStorage clearing says nothing about this store")
    assert.equal(peek("locale"), "vi")
})

test("this tab's own clear() and another tab's clear() behave the SAME", () => {
    // The asymmetry that made the hole worth fixing: one door, two outcomes,
    // decided by which window you were looking at.
    clear()
    put("locale", "vi")
    const mine = []
    let off = on("locale", (value) => mine.push(value))
    clear()
    off()

    put("locale", "vi")
    const theirs = []
    off = on("locale", (value) => theirs.push(value))
    store.clear() // their tab emptied the shared storage before the event fired
    deliver(storageEvent({ key: null }))
    off()

    assert.deepEqual(mine, theirs)
})
