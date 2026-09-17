import { test } from "node:test"
import assert from "node:assert/strict"
import { realm } from "../src/realm.js"

/**
 * The realm door — and the three things its refusal must NOT count.
 *
 * Each of the three was learned by breaking a working tree in the host that found
 * this law, so each has a case here: computing the fallback is not a read, asking
 * `scope` is not a read, and touching a verb is not calling it.
 *
 * The door's state lives on `globalThis` (a host may load this module twice in one
 * process), so every case clears it first — which is also the only way to observe
 * a FIRST read more than once.
 */
const STATE = "@akaoio/udb:realm"
const fresh = () => delete globalThis[STATE]

/** A store that records which root it was built for, and what was called on it. */
const spyOpen = (calls) => (root) => ({
    scope: root,
    readBytes: async (path) => (calls.push(["readBytes", root, path]), null),
    writeBytes: async () => {},
    remove: async () => {},
    entries: async () => []
})

test("with nothing declared, a Node realm answers its working directory", () => {
    fresh()
    const door = realm({ open: spyOpen([]) })
    assert.equal(door.current(), process.cwd())
})

test("a declared root is the answer, and declare hands back the one it replaced", () => {
    fresh()
    const door = realm({ open: spyOpen([]) })
    const previous = door.declare("/tmp/one")
    assert.equal(previous, process.cwd(), "so a caller can put it back")
    assert.equal(door.current(), "/tmp/one")
    assert.equal(door.declare("/tmp/two"), "/tmp/one")
})

test("the ambient store follows the root, and asking twice for a root is one object", async () => {
    fresh()
    const calls = []
    const door = realm({ open: spyOpen(calls) })
    door.declare("/tmp/one")
    await door.driver.readBytes(["a"])
    door.declare("/tmp/two")
    await door.driver.readBytes(["a"])
    assert.deepEqual(
        calls.map((c) => c[1]),
        ["/tmp/one", "/tmp/two"],
        "the same binding read two different stores"
    )
    assert.equal(door.at("/tmp/one"), door.at("/tmp/one"), "held, not rebuilt")
})

test("a root that ARRIVES after a real read of the fallback is REFUSED, naming both", async () => {
    fresh()
    const door = realm({ open: spyOpen([]) })
    await door.driver.readBytes(["package.json"]) // read, with nothing declared
    assert.throws(
        () => door.declare("/tmp/elsewhere", { arrived: true }),
        (error) => {
            assert.match(error.message, /\/tmp\/elsewhere/, "the root that arrived")
            assert.ok(error.message.includes(process.cwd()), "and the store that was actually read")
            return true
        }
    )
})

test("but COMPUTING the fallback is not a read — a gateway starts exactly that way", () => {
    fresh()
    const door = realm({ open: spyOpen([]) })
    assert.equal(door.current(), process.cwd(), "asking which root is fine")
    door.declare("/tmp/elsewhere", { arrived: true }) // must not throw
    assert.equal(door.current(), "/tmp/elsewhere")
})

test("reading a FIELD is not reading the store — `scope` is asked at wiring time", () => {
    // What holds this is that only FUNCTIONS are wrapped: a field can never mark the
    // realm as read, and neither can a field a driver grows later. An earlier draft
    // named `scope` in a second condition, and a bait proved that clause could not
    // fire — the string was never going to reach the wrapper. The bait for the real
    // law is "count any property read", and it turns this case red.
    fresh()
    const door = realm({ open: spyOpen([]) })
    assert.equal(typeof door.driver.scope, "string")
    assert.equal(door.driver.somethingAddedLater, undefined, "and an unknown field is just absent, not a read")
    door.declare("/tmp/elsewhere", { arrived: true }) // must not throw
})

test("and TOUCHING a verb is not calling it — a conformance check touches every one", () => {
    fresh()
    const door = realm({ open: spyOpen([]) })
    for (const verb of ["readBytes", "writeBytes", "remove", "entries"]) assert.equal(typeof door.driver[verb], "function")
    door.declare("/tmp/elsewhere", { arrived: true }) // must not throw
})

test("a caller STAGING a root is never the refused shape, however much it read first", async () => {
    fresh()
    const door = realm({ open: spyOpen([]) })
    await door.driver.readBytes(["package.json"])
    // No `arrived`: this is a deliberate move by someone holding the door.
    const previous = door.declare("/tmp/staged")
    assert.equal(previous, process.cwd())
    door.declare(previous)
})

test("a browser has ONE store per origin, so a root names nothing there", () => {
    fresh()
    const held = globalThis.process
    try {
        delete globalThis.process
        globalThis.location = { origin: "https://example.test" }
        const door = realm({ open: () => ({ scope: "OPFS", readBytes: async () => null, writeBytes: async () => {}, remove: async () => {}, entries: async () => [] }) })
        assert.equal(door.current(), "OPFS")
        assert.equal(door.at("/anything"), door.at("/something else"), "every root is the same store")
    } finally {
        globalThis.process = held
    }
})

test("it refuses a wiring with no open(root), by name", () => {
    // The message is the registry's now, not this file's: `conform()` names the
    // missing port and which door asked for it, the same way every other door does.
    assert.throws(() => realm({}), /open/)
})

test("a root that has ALREADY arrived is the root — not the fallback, and not a default", () => {
    // The regression this exists for: an entry point may put its root where the host
    // collects them and then simply start working, without ever calling `declare`. A
    // suite pointing itself at a built tree does exactly that. Without the question,
    // such a realm answers the fallback and reads the wrong tree — and the failure
    // names no tree: measured on the host that adopted this door, where a file plainly
    // present in the built tree came back as "missing from the build".
    fresh()
    let collected = "/tmp/arrived-here"
    const door = realm({ open: spyOpen([]), arrived: () => collected })
    assert.equal(door.current(), "/tmp/arrived-here", "the arrived root wins over the fallback")
})

test("and it is asked at FIRST USE, so a root arriving after the import still counts", () => {
    // A value captured at import time would read an empty collection point and then be
    // wrong for the rest of the process — which is why this is a question.
    fresh()
    let collected = null
    const door = realm({ open: spyOpen([]), arrived: () => collected })
    collected = "/tmp/arrived-late" // after the door was built, before anything read
    assert.equal(door.current(), "/tmp/arrived-late")
})

test("a realm that STARTED from an arrived root has no refusal window at all", async () => {
    // The refusal watches for a root arriving AFTER the fallback was read. A realm
    // that began with an arrived root was never on the fallback, so a second root
    // arriving is an ordinary re-declaration — and refusing it would break every
    // process that legitimately moves on.
    fresh()
    const door = realm({ open: spyOpen([]), arrived: () => "/tmp/first" })
    await door.driver.readBytes(["a"]) // a real read, against the arrived root
    door.declare("/tmp/second", { arrived: true }) // must not throw
    assert.equal(door.current(), "/tmp/second")
})

test("with nothing arrived, the fallback still stands — and the refusal still fires", async () => {
    fresh()
    const door = realm({ open: spyOpen([]), arrived: () => null, fallback: "/tmp/fell-back" })
    assert.equal(door.current(), "/tmp/fell-back")
    await door.driver.readBytes(["a"])
    assert.throws(() => door.declare("/tmp/elsewhere", { arrived: true }), /\/tmp\/fell-back/)
})
