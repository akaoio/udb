import { test } from "node:test"
import assert from "node:assert/strict"
import { match, compile } from "../src/filter.js"

// The matcher side of the conformance table. The host that injects a real
// SQL engine runs the SAME cases through compile() against it — here we pin
// the language; there they pin the parity.
const DOCS = {
    a: { kind: "swap", amount: 5, ok: true, meta: { priority: "high" }, tag: null },
    b: { kind: "swap", amount: 0.5, ok: false, meta: { priority: "low" } },
    c: { kind: "send", amount: 12, ok: true },
    d: { kind: "send", amount: 5, note: "five" }
}

const CASES = [
    ["empty filter matches all", {}, ["a", "b", "c", "d"]],
    ["implicit equality", { kind: "swap" }, ["a", "b"]],
    ["multiple fields AND", { kind: "send", amount: 5 }, ["d"]],
    ["$gt", { amount: { $gt: 5 } }, ["c"]],
    ["$gte + $lt range", { amount: { $gte: 5, $lt: 12 } }, ["a", "d"]],
    ["$ne includes missing fields", { note: { $ne: "five" } }, ["a", "b", "c"]],
    ["$in", { kind: { $in: ["send"] } }, ["c", "d"]],
    ["empty $in matches nothing", { kind: { $in: [] } }, []],
    ["$nin includes missing fields", { note: { $nin: ["five"] } }, ["a", "b", "c"]],
    ["empty $nin matches everything", { kind: { $nin: [] } }, ["a", "b", "c", "d"]],
    ["boolean equality", { ok: true }, ["a", "c"]],
    ["boolean false", { ok: false }, ["b"]],
    ["dot path", { "meta.priority": "high" }, ["a"]],
    ["explicit null is NOT a missing field", { tag: null }, ["a"]],
    ["$ne null means present-and-not-null OR missing", { tag: { $ne: null } }, ["b", "c", "d"]],
    ["OR combinator", { "|": [{ kind: "send" }, { amount: { $lt: 1 } }] }, ["b", "c", "d"]],
    ["AND + OR nested", { kind: "swap", "|": [{ ok: true }, { amount: { $lt: 1 } }] }, ["a", "b"]],
    ["AND combinator explicit", { "&": [{ kind: "swap" }, { ok: true }] }, ["a"]]
]

for (const [name, filter, expected] of CASES)
    test(`match: ${name}`, () => {
        const got = Object.entries(DOCS)
            .filter(([, doc]) => match(doc, filter))
            .map(([id]) => id)
        assert.deepEqual(got, expected)
    })

test("compile: booleans bind as 0/1 — how SQLite stores JSON booleans", () => {
    const { where, params } = compile({ ok: true })
    assert.match(where, /json_extract/)
    assert.deepEqual(params, [1])
})

test("compile: empty $in is a contradiction, empty $nin a tautology", () => {
    assert.equal(compile({ k: { $in: [] } }).where, "1=0")
    assert.equal(compile({ k: { $nin: [] } }).where, "1=1")
})

test("compile: null goes through json_type, never through =", () => {
    const { where, params } = compile({ tag: null })
    assert.match(where, /json_type/)
    assert.deepEqual(params, [])
})

test("compile: empty filter is 1=1", () => {
    assert.equal(compile({}).where, "1=1")
})
