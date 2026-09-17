import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeDriver } from "../src/driver/node.js"
import { opfsDriver } from "../src/driver/opfs.js"
import { chainStore } from "../src/kv/index.js"
import { checkStore } from "../src/kv/conformance.js"
import { collections } from "../src/index.js"
import { memoryDirectory } from "./opfs-handles.js"

/**
 * The chain-store this package ships, and the kit that says what a store MEANS.
 *
 * One implementation over the `driver` port, so both realms are the same code
 * and the realm question stays answered in exactly one place. The kit is run
 * against it here and is exported for hosts to run against their own.
 */
const scratch = () => mkdtempSync(join(tmpdir(), "udb-kv-"))

test("the chain-store keeps every promise of the store port, on a disk", async () => {
    const root = scratch()
    try {
        await checkStore(chainStore({ driver: nodeDriver({ root }) }))
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("and the same code keeps them over the browser's driver", async () => {
    await checkStore(chainStore({ driver: opfsDriver({ root: memoryDirectory() }) }))
})

test("one document per FILE — the whole collection is not rewritten on every save", async () => {
    // The engine this replaces kept a collection in one json file and rewrote it
    // whole on every put, which is silently quadratic in a directory that grows.
    const root = scratch()
    try {
        const store = chainStore({ driver: nodeDriver({ root }) })
        for (const id of ["a", "b", "c"]) await store.get("people").get(id).put({ id })
        assert.deepEqual(readdirSync(join(root, "people")).sort(), ["a.json", "b.json", "c.json"])
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("a node holds a value AND children, and deleting it takes the subtree", async () => {
    const root = scratch()
    try {
        const store = chainStore({ driver: nodeDriver({ root }) })
        await store.get("a").put({ n: 1 })
        await store.get("a").get("b").put({ n: 2 })
        assert.equal((await store.get("a").once())?.n, 1)
        assert.equal((await store.get(["a", "b"]).once())?.n, 2)
        await store.get("a").del()
        assert.equal(await store.get("a").once(), undefined)
        assert.equal(await store.get(["a", "b"]).once(), undefined, "the children go with the parent")
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("a corrupt body is not a document, and does not throw out of a read or a walk", async () => {
    const root = scratch()
    try {
        const driver = nodeDriver({ root })
        const store = chainStore({ driver })
        await store.get("rows").get("good").put({ n: 1 })
        await driver.writeBytes(["rows", "broken.json"], new TextEncoder().encode("{not json"))
        assert.equal(await store.get("rows").get("broken").once(), undefined)
        const seen = []
        await store.get("rows").map((document, path) => seen.push(path.at(-1)))
        assert.deepEqual(seen, ["good"], "map() walks past a body that is not a document rather than dying on it")
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("it drives the kv engine of collections — the port it was missing", async () => {
    const root = scratch()
    try {
        const store = chainStore({ driver: nodeDriver({ root }) })
        const mount = collections({ kv: () => store })("orders")
        await mount.verbs.put(["a1"], { id: "a1", status: "open", size: 2 })
        await mount.verbs.put(["a2"], { id: "a2", status: "done", size: 1 })
        assert.equal((await mount.verbs.once(["a1"]))?.size, 2)
        const open = await mount.verbs.find([], { status: "open" })
        assert.deepEqual(
            open.map((document) => document.id),
            ["a1"]
        )
        await mount.verbs.del(["a1"])
        assert.equal(await mount.verbs.once(["a1"]), undefined)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("the kit catches a store whose map() names nothing — a collection that comes back empty", async () => {
    const root = scratch()
    try {
        const honest = chainStore({ driver: nodeDriver({ root }) })
        const liar = {
            ...honest,
            get: (segment) => {
                const node = honest.get(segment)
                return { ...node, get: (child) => liar.get([...(Array.isArray(segment) ? segment : [segment]), child]), map: async () => [] }
            }
        }
        await assert.rejects(() => checkStore(liar), /map\(\) must visit every child document/)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("and one whose on() never delivers — a fan-out that is silently a no-op", async () => {
    const root = scratch()
    try {
        const honest = chainStore({ driver: nodeDriver({ root }) })
        const deaf = {
            ...honest,
            get: (segment) => {
                const node = honest.get(segment)
                const wrap = (inner) => ({ ...inner, get: (child) => wrap(inner.get(child)), on: () => () => {} })
                return wrap(node)
            }
        }
        await assert.rejects(() => checkStore(deaf), /on\(\) must deliver a write/)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("a read of a BRANCH assembles the subtree, and an exact document still wins", async () => {
    // What a real host's store already did, and the only reason this one could
    // not replace it: writes go four levels down, reads happen at the branch.
    const root = scratch()
    try {
        const store = chainStore({ driver: nodeDriver({ root }) })
        await store.get("pools").get("eth").get("0xaaa").put({ price: 1 })
        await store.get("pools").get("bsc").get("0xbbb").put({ price: 2 })
        assert.deepEqual(await store.get("pools").once(), { eth: { "0xaaa": { price: 1 } }, bsc: { "0xbbb": { price: 2 } } })
        await store.get("pools").put({ note: "the branch has a value of its own" })
        assert.deepEqual(await store.get("pools").once(), { note: "the branch has a value of its own" }, "an exact document wins over assembly")
        assert.equal(await store.get("nothing").once(), undefined, "and a branch with nothing under it is still undefined")
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("an ancestor with a subscriber hears the assembled subtree, and one without pays nothing", async () => {
    const root = scratch()
    try {
        const store = chainStore({ driver: nodeDriver({ root }) })
        const heard = []
        await store.get("pools").on((value) => heard.push(value))
        await store.get("pools").get("eth").get("0xaaa").put({ price: 3 })
        assert.deepEqual(heard.at(-1), { eth: { "0xaaa": { price: 3 } } }, "the ancestor hears what once() would answer it")
        // No subscriber on this branch: the write must not assemble anything.
        await store.get("quiet").get("a").put({ n: 1 })
        assert.equal(heard.length, 1, "a tree with no subscribers pays for no assembly")
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test("map reaches EVERY depth — a prefix in a tree is not just its first floor", async () => {
    const root = scratch()
    try {
        const store = chainStore({ driver: nodeDriver({ root }) })
        await store.get("a").get("b").put({ n: 1 })
        await store.get("a").get("b").get("c").put({ n: 2 })
        const seen = []
        const count = await store.get("a").map((document, path) => seen.push([path.join("/"), document.n]))
        assert.equal(count, 2)
        assert.deepEqual(seen.sort(), [["a/b", 1], ["a/b/c", 2]])
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})
