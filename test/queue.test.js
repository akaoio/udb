import { test } from "node:test"
import assert from "node:assert/strict"
import { CallQueue } from "../src/sqlite/queue.js"

/**
 * The call queue in front of a SQL transport — every promise it makes.
 *
 * A fake transport, on purpose: the queue never learns what carries its calls, so
 * the contract is measurable with no worker, no socket and no database. What is
 * pinned here is the part a host paid for before this moved — one line per
 * DATABASE rather than one per realm, and a timeout that flushes only its own.
 */
function transport() {
    const pending = []
    return {
        pending,
        send: (method, params, callback) => pending.push({ method, params, callback }),
        answer: (index, response, error) => pending[index].callback(response, error)
    }
}

test("one call in flight at a time, answered in order", async () => {
    const carrier = transport()
    const queue = new CallQueue({ send: carrier.send })
    const first = queue.call("run", { sql: "A" })
    const second = queue.call("run", { sql: "B" })
    assert.equal(carrier.pending.length, 1, "strictly one in flight — the second waits")
    carrier.answer(0, "A")
    assert.equal(await first, "A")
    assert.equal(carrier.pending.length, 2, "and the second goes out only once the first is answered")
    carrier.answer(1, "B")
    assert.equal(await second, "B")
})

test("an error from the transport rejects that call and the line keeps moving", async () => {
    const carrier = transport()
    const queue = new CallQueue({ send: carrier.send })
    const first = queue.call("run", {})
    const second = queue.call("get", {})
    carrier.answer(0, null, new Error("no such table"))
    await assert.rejects(() => first, /no such table/)
    carrier.answer(1, "second answer")
    assert.equal(await second, "second answer")
})

test("a transport that never answers rejects this call AND the ones behind it", async () => {
    const carrier = transport()
    const queue = new CallQueue({ send: carrier.send, defaultTimeout: 20 })
    const first = queue.call("run", {})
    const second = queue.call("run", {})
    await assert.rejects(() => first, /transport unresponsive: run/)
    await assert.rejects(() => second, /flushed this database's queue/)
})

test("and a SIBLING database keeps its own line — the reason this is per database", async () => {
    // The failure this class was extracted from: one queue per realm meant a
    // watchdog firing on one database flushed every other database's in-flight
    // work, and a slow query on one delayed them all.
    const wedged = transport()
    const healthy = transport()
    const a = new CallQueue({ send: wedged.send, defaultTimeout: 20 })
    const b = new CallQueue({ send: healthy.send, defaultTimeout: 5000 })
    const dead = a.call("run", {})
    const alive = b.call("run", {})
    await assert.rejects(() => dead, /unresponsive/)
    healthy.answer(0, "still fine")
    assert.equal(await alive, "still fine", "the sibling was never touched")
})

test("a late answer after the watchdog fired is ignored, not delivered twice", async () => {
    const carrier = transport()
    const queue = new CallQueue({ send: carrier.send, defaultTimeout: 20 })
    const call = queue.call("run", {})
    await assert.rejects(() => call, /unresponsive/)
    // The transport wakes up and answers anyway; nothing may resolve now.
    assert.doesNotThrow(() => carrier.answer(0, "too late"))
})

test("a per-method timeout overrides the default", async () => {
    const carrier = transport()
    const queue = new CallQueue({ send: carrier.send, timeouts: { slow: 4000 }, defaultTimeout: 20 })
    const quick = queue.call("run", {})
    await assert.rejects(() => quick, /unresponsive/)
    const slow = queue.call("slow", {})
    // Still in flight after the default would have fired: the override is honoured.
    await new Promise((resolve) => setTimeout(resolve, 60))
    carrier.answer(1, "in time")
    assert.equal(await slow, "in time")
})

test("it refuses a wiring with no transport — by name, at construction", () => {
    assert.throws(() => new CallQueue({}), /needs a send\(method, params, callback\) transport/)
})
