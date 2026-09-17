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
