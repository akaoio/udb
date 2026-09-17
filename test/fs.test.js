import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeDriver } from "../src/driver/node.js"
import { fs as fileDoor } from "../src/fs.js"

/**
 * The file door — the verbs, and the ergonomics they were chosen for.
 *
 * A real driver on a real temporary directory, because what is under test is the
 * door's behaviour over a store rather than the store itself: the drivers have
 * their own suite and their own conformance kits.
 */
const encode = (text) => new TextEncoder().encode(text)
const text = (bytes) => new TextDecoder().decode(bytes)
const open = (wiring = {}) => {
    const at = mkdtempSync(join(tmpdir(), "udb-fs-"))
    return { door: fileDoor({ driver: nodeDriver({ root: at }), ...wiring }), at, clean: () => rmSync(at, { recursive: true, force: true }) }
}

test("a QUESTION answers, even about nothing — absence is not an incident", async () => {
    const store = open()
    try {
        assert.equal(await store.door.exists(["nope.json"]), false)
        assert.equal(await store.door.isDir(["nope"]), false)
        assert.deepEqual(await store.door.list(["nope"]), [])
        assert.equal(await store.door.find([["a"], ["b"]]), undefined)
        assert.equal(await store.door.load(["nope.json"], { quiet: true }), undefined)
    } finally {
        store.clean()
    }
})

test("a COMMAND that fails THROWS — a step that cannot fail is the bug", async () => {
    // The bill (akao #858): a copy that logged and answered `undefined` made every
    // vendor step of a build incapable of failing. One red line in a thousand-line
    // log, exit 0, and the page 404s that module the first time it is needed —
    // neither build time nor test time. The optional case is a GUARD at the call
    // site, never a silence inside the door.
    const store = open()
    try {
        assert.equal(await store.door.write(["a.json"], { a: 1 }), true)
        assert.deepEqual(await store.door.load(["a.json"]), { a: 1 })
        assert.equal(await store.door.remove(["a.json"]), true)
        assert.equal(await store.door.exists(["a.json"]), false)
        await assert.rejects(
            () => store.door.move(["missing"], ["elsewhere"]),
            (error) => {
                assert.match(error.message, /move failed at missing/, "the verb and the path are in the message")
                assert.equal(error.message.split("[FS]").length - 1, 1, "wrapped exactly once")
                assert.ok(error.cause, "and the original survives as the cause")
                return true
            }
        )
    } finally {
        store.clean()
    }
})

test("nothing to write is not a failure and not a write", async () => {
    // A caller building a document conditionally passes undefined on purpose.
    const store = open()
    try {
        assert.equal(await store.door.write(["a.json"], undefined), false)
        assert.equal(await store.door.exists(["a.json"]), false)
    } finally {
        store.clean()
    }
})

test("a deep copy names the LEAF that failed, not the root of the walk", async () => {
    // A message naming the root tells a reader which command was run, which they
    // already knew, and hides which file could not be written.
    const store = open()
    try {
        await store.door.write(["from", "deep", "leaf.json"], { a: 1 })
        await store.door.write(["blocked"], "not a directory")
        await assert.rejects(
            () => store.door.copy(["from"], ["blocked", "under"]),
            (error) => {
                assert.match(error.message, /blocked\/under/, "the leaf is named")
                assert.equal(error.message.split("[FS]").length - 1, 1, "and it is wrapped once, however deep the walk went")
                return true
            }
        )
    } finally {
        store.clean()
    }
})

test("an object bound for a path with NO extension is refused, not written", async () => {
    // The shape that silently writes "[object Object]" to disk and is found weeks
    // later by whoever tries to read it back.
    const store = open()
    try {
        await assert.rejects(() => store.door.write(["configs"], { a: 1 }), /an object needs an extension/)
        assert.equal(await store.door.exists(["configs"]), false, "and nothing landed")
    } finally {
        store.clean()
    }
})

test("bytes pass straight through, and a string is written as itself", async () => {
    const store = open()
    try {
        await store.door.write(["raw.bin"], new Uint8Array([1, 2, 3]))
        assert.deepEqual(await store.door.driver.readBytes(["raw.bin"]), new Uint8Array([1, 2, 3]))
        await store.door.write(["note.txt"], "hello")
        assert.equal(text(await store.door.driver.readBytes(["note.txt"])), "hello")
    } finally {
        store.clean()
    }
})

test("the host's vocabulary decides how a document is SPELLED, both ways", async () => {
    const store = open({
        stringify: (content, name) => encode(name.endsWith(".yaml") ? `spelled: ${content.key}` : JSON.stringify(content)),
        parse: (bytes, name) => (name.endsWith(".yaml") ? { read: text(bytes) } : JSON.parse(text(bytes)))
    })
    try {
        await store.door.write(["a.yaml"], { key: "v" })
        assert.equal(text(await store.door.driver.readBytes(["a.yaml"])), "spelled: v")
        assert.deepEqual(await store.door.load(["a.yaml"]), { read: "spelled: v" })
    } finally {
        store.clean()
    }
})

test("copy takes a subtree and says what it did, skip included", async () => {
    const store = open()
    try {
        await store.door.write(["from", "a.json"], { a: 1 })
        await store.door.write(["from", "deep", "b.json"], { b: 2 })
        await store.door.write(["from", "skipme", "c.json"], { c: 3 })
        const result = await store.door.copy(["from"], ["to"], { skip: (path) => path.at(-1) === "skipme" })
        assert.deepEqual(result, { copied: 2, skipped: 1 }, "a skipped subtree and a copied one are two different facts")
        assert.deepEqual(await store.door.load(["to", "deep", "b.json"]), { b: 2 })
        assert.equal(await store.door.exists(["to", "skipme", "c.json"]), false)
    } finally {
        store.clean()
    }
})

test("dir with a pattern matches the RELATIVE path, so the root can move", async () => {
    // A regex written against the absolute path is a regex pinned to one machine's
    // directory layout.
    const store = open()
    try {
        await store.door.write(["x", "one.json"], { a: 1 })
        await store.door.write(["x", "deep", "two.yaml"], "k: v")
        assert.deepEqual((await store.door.dir(["x"], /\.json$/)).sort(), ["one.json"])
        assert.deepEqual((await store.door.dir(["x"], /^deep\//)).sort(), ["deep/two.yaml"])
        assert.deepEqual((await store.door.dir(["x"])).sort(), ["deep", "one.json"], "with no pattern it is one level, like the driver's list")
    } finally {
        store.clean()
    }
})

test("an `origin` gives the door a network tier without the host spelling URLs", async () => {
    const asked = []
    const store = open({
        origin: "https://o",
        fetch: async (url) => {
            asked.push(url)
            return { ok: true, status: 200, arrayBuffer: async () => encode('{"from":"origin"}').buffer }
        }
    })
    try {
        assert.deepEqual(await store.door.load(["a.json"]), { from: "origin" })
        assert.deepEqual(asked, ["https://o/a.json"])
        assert.equal(text(await store.door.driver.readBytes(["a.json"])), '{"from":"origin"}', "written through as it landed")
    } finally {
        store.clean()
    }
})

test("no origin and no urlOf means the store IS the origin — nothing is fetched", async () => {
    const asked = []
    const store = open({ fetch: async (url) => (asked.push(url), { ok: false, status: 404 }) })
    try {
        await store.door.write(["a.json"], { from: "store" })
        assert.deepEqual(await store.door.load(["a.json"]), { from: "store" })
        assert.deepEqual(asked, [])
    } finally {
        store.clean()
    }
})

test("download names the file from the URL when the path does not", async () => {
    const store = open({
        fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => encode("bytes").buffer })
    })
    try {
        assert.deepEqual(await store.door.download("https://o/deep/picture.png", ["images"]), ["images", "picture.png"])
        assert.equal(text(await store.door.driver.readBytes(["images", "picture.png"])), "bytes")
        assert.deepEqual(await store.door.download("https://o/x", ["images", "named.png"]), ["images", "named.png"], "a path that names a file wins")
    } finally {
        store.clean()
    }
})

test("download REFUSES a non-2xx instead of writing an error page into the store", async () => {
    // The worst of the three outcomes, because every later read succeeds: an HTML
    // error page sitting under the name of the asset.
    const store = open({ fetch: async () => ({ ok: false, status: 503 }) })
    try {
        await assert.rejects(() => store.door.download("https://o/a.png", ["images"]), /answered 503/)
        assert.equal(await store.door.exists(["images", "a.png"]), false)
    } finally {
        store.clean()
    }
})

test("it refuses a wiring with no store, by name, at construction", () => {
    assert.throws(() => fileDoor({}), /driver/)
})
