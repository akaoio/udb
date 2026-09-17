import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeDriver } from "../src/driver/node.js"
import { opfsDriver } from "../src/driver/opfs.js"
import { checkDriver } from "../src/driver/conformance.js"
import { memoryDirectory } from "./opfs-handles.js"

/**
 * The drivers this package ships, and the kit that says what a driver MEANS.
 *
 * Both realms answer the same behavioural contract, run by the same function —
 * which is the point of shipping the kit: a host's own driver is checked by the
 * same assertions, in the host's suite, instead of by whatever that host guessed
 * the engines expected.
 */
test("the Node driver keeps every promise of the port", async () => {
    const root = mkdtempSync(join(tmpdir(), "udb-driver-"))
    try {
        await checkDriver(nodeDriver({ root }))
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("the OPFS driver keeps the same promises, against the same handle interface a browser gives it", async () => {
    await checkDriver(opfsDriver({ root: memoryDirectory() }))
})

test("the OPFS driver QUEUES writes to one path — the browser refuses a second writable", async () => {
    // Without the queue this throws NoModificationAllowedError, which is the
    // failure that appears the day an app gets busy and never before.
    const driver = opfsDriver({ root: memoryDirectory() })
    const encoder = new TextEncoder()
    await Promise.all([driver.writeBytes(["busy.json"], encoder.encode("1")), driver.writeBytes(["busy.json"], encoder.encode("2")), driver.writeBytes(["busy.json"], encoder.encode("3"))])
    const read = new TextDecoder().decode(await driver.readBytes(["busy.json"]))
    assert.ok(["1", "2", "3"].includes(read), `one of the writes won cleanly, rather than any of them throwing (read ${read})`)
})

test("a driver that answers a MISS by throwing is caught by the kit, not by a user", async () => {
    // Shape is not meaning: this driver has all four methods and a scope.
    const root = mkdtempSync(join(tmpdir(), "udb-driver-bad-"))
    try {
        const honest = nodeDriver({ root })
        const liar = { ...honest, readBytes: async (path) => (await honest.readBytes(path)) ?? Promise.reject(new Error("ENOENT")) }
        await assert.rejects(() => checkDriver(liar), /absence is an answer|must answer null/)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("a driver that does not mark directories is caught — a walk would see a flat tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "udb-driver-flat-"))
    try {
        const honest = nodeDriver({ root })
        const flat = { ...honest, entries: async (path) => (await honest.entries(path)).map(({ name }) => ({ name })) }
        await assert.rejects(() => checkDriver(flat), /isDir/)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("the kit refuses a driver of the wrong SHAPE before it tests meaning", async () => {
    await assert.rejects(() => checkDriver({ scope: "x" }), /missing readBytes\(\)/)
    await assert.rejects(() => checkDriver({ ...nodeDriver({ root: "." }), scope: "" }), /must declare scope/)
})

test("a SYNCHRONOUS port method is conformant, and the kit must not crash on one", async () => {
    // The contract says "a function", not "a function that returns a promise".
    // The first version of this kit called `.catch()` on what `remove()`
    // answered with, so a host whose driver is synchronous got a TypeError from
    // inside the kit — a crash where a verdict was owed. Measured against a real
    // host's driver the day the kit shipped.
    const root = mkdtempSync(join(tmpdir(), "udb-driver-sync-"))
    try {
        const honest = nodeDriver({ root })
        const pending = []
        const sync = {
            ...honest,
            remove: (path) => {
                pending.push(honest.remove(path))
            },
            writeBytes: (path, bytes) => {
                pending.push(honest.writeBytes(path, bytes))
            }
        }
        // The stand-in is deliberately awkward: it answers undefined and does the
        // work in the background, which is what "not a promise" looks like at its
        // most inconvenient. The kit must still reach a verdict rather than throw.
        await assert.rejects(() => checkDriver(sync), /does not keep/)
        await Promise.allSettled(pending)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("NO method's return value is ever .catch()-ed inside the kits — the rule, not one instance", () => {
    // Fixing the first two call sites left a third, and it crashed the same way
    // on the same host an hour later. The rule is mechanical, so it is measured
    // mechanically: a kit may `await` a port method and wrap it in try/catch, and
    // may not reach for `.catch` on what it answered with.
    for (const file of ["../src/driver/conformance.js", "../src/kv/conformance.js"]) {
        const source = readFileSync(new URL(file, import.meta.url), "utf8")
        const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
        assert.ok(!/\.catch\s*\(/.test(code), `${file} calls .catch() on something a port answered with — a port method may be synchronous, and that is a crash where a verdict is owed`)
    }
})
