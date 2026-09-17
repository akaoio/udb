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

test("both drivers offer the whole file door, and keep its promises too", async () => {
    // Six verbs beyond the port. A host with a file layer of its own needs them,
    // and was writing them over the same backend this package already talks to.
    const { checkFileDoor } = await import("../src/driver/conformance.js")
    const root = mkdtempSync(join(tmpdir(), "udb-file-door-"))
    try {
        await checkFileDoor(nodeDriver({ root }))
        await checkFileDoor(opfsDriver({ root: memoryDirectory() }))
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("a door whose move() leaves the source behind is a copy with a wrong name", async () => {
    const { checkFileDoor } = await import("../src/driver/conformance.js")
    const root = mkdtempSync(join(tmpdir(), "udb-file-door-bad-"))
    try {
        const honest = nodeDriver({ root })
        await assert.rejects(() => checkFileDoor({ ...honest, move: honest.copyFile }), /source must be GONE/)
        await assert.rejects(() => checkFileDoor({ ...honest, isDir: async () => true }), /FALSE for a file/)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("a segment that is not a string is REFUSED by name, not guessed at", async () => {
    // node:path throws a TypeError from inside itself on a number, and the statics
    // engine above catches everything a read throws and reads it as "nothing at
    // rest". Measured against a real host whose own law allows a number segment (a
    // chain id): a 663-byte file that was plainly there answered null, and nothing
    // in the failure mentioned a number.
    const root = mkdtempSync(join(tmpdir(), "udb-driver-segment-"))
    try {
        const driver = nodeDriver({ root })
        await assert.rejects(() => driver.readBytes(["chains", 1, "configs.json"]), /segment 1 .* is a number/)
        await assert.rejects(() => driver.readBytes(["a", null]), /is null, not a string/)
        await assert.rejects(() => driver.readBytes(["a", ["b", "c"]]), /an array .* spread it/)
        await assert.rejects(() => driver.readBytes("a/b"), /a path is an ARRAY/)
        // And the browser driver answers the same way, because the law is the path's.
        const opfs = opfsDriver({ root: memoryDirectory() })
        await assert.rejects(() => opfs.readBytes(["chains", 1]), /not a string/)
        await assert.rejects(() => opfs.entries([{}]), /not a string/)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("a FILE is not an empty directory — the promise that turned every file into one", async () => {
    // Measured against a real host: it tested "is this a directory" by LISTING the
    // path and checking the answer was an array — correct against a driver that
    // throws, wrong against one that answers []. Its build stopped with "carries
    // configs.yaml AND the subdirectories configs.yaml, pools.yaml", a sentence
    // that cannot be true, and the kit had never asked the question.
    const root = mkdtempSync(join(tmpdir(), "udb-notdir-"))
    try {
        const driver = nodeDriver({ root })
        await driver.writeBytes(["a.json"], new TextEncoder().encode("1"))
        await assert.rejects(() => driver.entries(["a.json"]), /is a FILE, not a directory/)
        await assert.rejects(() => driver.list(["a.json"]), /is a FILE, not a directory/)
        assert.deepEqual(await driver.entries(["nowhere"]), [], "while a directory that does not exist still answers []")
        assert.deepEqual(await driver.list(["nowhere"]), [])

        // The browser driver answers the same way: the platform says
        // TypeMismatchError for a file, which is not NotFoundError.
        const opfs = opfsDriver({ root: memoryDirectory() })
        await opfs.writeBytes(["b.json"], new TextEncoder().encode("1"))
        await assert.rejects(() => opfs.entries(["b.json"]), /is a FILE, not a directory/)
        assert.deepEqual(await opfs.entries(["nowhere"]), [])
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("a path names a place INSIDE the store — absolute and `..` are refused", async () => {
    // `node:path.join` cannot enforce this and does not say so: join("/root",
    // "/etc/passwd") is "/root/etc/passwd" and join("/a/b/c", "..", "..") is "/a"
    // — the first is a different place than the caller asked for, the second is
    // OUTSIDE the store, and both are silent. Measured on the host that first
    // adopted these drivers: a write with an absolute segment landed at
    // <root>/home/x/akao/package.json and nothing said a word.
    const root = mkdtempSync(join(tmpdir(), "udb-inside-"))
    try {
        for (const driver of [nodeDriver({ root }), opfsDriver({ root: memoryDirectory() })]) {
            await assert.rejects(() => driver.readBytes(["/etc", "passwd"]), /OUTSIDE this store/)
            await assert.rejects(() => driver.writeBytes(["/tmp", "x"], new Uint8Array(0)), /OUTSIDE this store/)
            await assert.rejects(() => driver.entries(["..", ".."]), /OUTSIDE this store/)
            await assert.rejects(() => driver.readBytes(["C:", "x"]), /OUTSIDE this store/)
            // `.` addresses the same place, so it is not an escape.
            assert.equal(await driver.readBytes([".", "nothing.json"]), null)
        }
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

/**
 * The DOOR — `driver()` — which had no test of its own until now.
 *
 * What it decides is which backend a realm can even have, and it used to decide
 * that by asking whether an OPFS exists. Node answers no and gets the Node
 * driver, which is right by accident; a browser in a private window answers no
 * too and got `import "node:fs/promises"` — a module-resolution error, in a realm
 * with no filesystem, three layers from the cause. Nothing here covered it
 * because nothing here loaded this file at all.
 *
 * `globals` is what makes the branches measurable: the realm is decided from the
 * object handed in, so a Node process can ask what a browser would have been
 * told. The drivers themselves still reach for the real platform — these cases
 * assert WHICH one was chosen, never that OPFS works in Node.
 */
const NODE_GLOBALS = { process: { versions: { node: "24.0.0" } } }
const BROWSER_NO_OPFS = { location: { origin: "https://example.com" }, navigator: {} }
const BROWSER_WITH_OPFS = { location: { origin: "https://example.com" }, navigator: { storage: { getDirectory: () => {} } } }

test("door: a Node realm gets the Node driver, rooted where it was asked", async () => {
    const { driver } = await import("../src/driver/index.js")
    const at = mkdtempSync(join(tmpdir(), "udb-door-"))
    const built = await driver({ root: at }, NODE_GLOBALS)
    assert.equal(built.scope, at, "the Node driver names its store by the root it resolved")
    await built.writeBytes(["a.txt"], new TextEncoder().encode("x"))
    assert.equal(new TextDecoder().decode(await built.readBytes(["a.txt"])), "x", "it wrote under the root it was handed")
    rmSync(at, { recursive: true, force: true })
})

test("door: a browser realm WITH an OPFS gets the OPFS driver", async () => {
    const { driver } = await import("../src/driver/index.js")
    const built = await driver({ scope: "OPFS" }, BROWSER_WITH_OPFS)
    // Construction only — the driver reaches for the real platform when CALLED,
    // and there is no OPFS in Node to call. What is decidable here is the choice.
    assert.equal(built.scope, "OPFS")
    assert.equal(typeof built.writeBytes, "function")
})

test("door: a browser realm with NO OPFS is refused BY NAME, not handed node:fs", async () => {
    const { driver } = await import("../src/driver/index.js")
    await assert.rejects(() => driver({}, BROWSER_NO_OPFS), (error) => {
        assert.match(error.message, /no Origin Private File System/, "it names the missing platform")
        assert.match(error.message, /supportsOPFS/, "and points at the question a host should ask first")
        assert.doesNotMatch(error.message, /node:fs/, "the old failure named node:fs in a realm that has none")
        return true
    })
})

test("door: a realm that is NEITHER says so, instead of guessing a backend", async () => {
    const { driver } = await import("../src/driver/index.js")
    await assert.rejects(() => driver({}, {}), /neither Node nor a browser/)
})

test("door: the realm decides the backend, NOT the presence of a store", async () => {
    // The regression in one line: a Node realm has no OPFS either, so asking
    // about OPFS first gives the right answer here and the wrong one in a page.
    const { driver } = await import("../src/driver/index.js")
    const { supportsOPFS } = await import("../src/driver/index.js")
    assert.equal(supportsOPFS(NODE_GLOBALS), false, "Node has no OPFS")
    const built = await driver({ root: "." }, NODE_GLOBALS)
    assert.equal(typeof built.entries, "function", "and still gets a driver, by REALM")
    assert.equal(supportsOPFS(BROWSER_NO_OPFS), false, "so does a private window — the same answer")
    await assert.rejects(() => driver({}, BROWSER_NO_OPFS), /browser realm/, "but a different outcome, which is the fix")
})
