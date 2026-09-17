import { test } from "node:test"
import assert from "node:assert/strict"
import { vocabulary } from "../src/vocabulary.js"

/**
 * What bytes SPELL — the middle of a vocabulary, which turned out not to be a host's.
 *
 * `fs()` takes `parse`/`stringify` as ports and calls them the host's own. Measured on
 * the host that adopted that door: 171 lines answered those two ports, 135 of them a
 * dependency-free CSV codec, and of the suffix list exactly ONE entry was that host's.
 * So the middle ships here and the EDGES stay ports.
 */
const encode = (text) => new TextEncoder().encode(text)
const text = (bytes) => new TextDecoder().decode(bytes)

test("the formats every host has: JSON, CSV, TSV, text", () => {
    const v = vocabulary({})
    assert.deepEqual(v.parse(encode('{"a":1}'), "x.json"), { a: 1 })
    assert.deepEqual(v.parse(encode("a,b\n1,2"), "x.csv"), [{ a: "1", b: "2" }])
    assert.deepEqual(v.parse(encode("a\tb\n1\t2"), "x.tsv"), [{ a: "1", b: "2" }])
    assert.equal(v.parse(encode("  hello  "), "x.txt"), "hello", "text is trimmed")
})

test("a suffix nobody calls text carries BYTES, and comes back as bytes", () => {
    // Guessing text for an unknown suffix is how a PNG becomes a string of question
    // marks — and the caller cannot tell, because a string is what it asked for.
    const v = vocabulary({})
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    assert.deepEqual(v.parse(raw, "logo.png"), raw)
    assert.equal(v.isText("logo.png"), false)
    assert.equal(v.isText("notes.md"), true)
    assert.equal(v.isText("Makefile"), true, "no suffix at all is text — a name is not a format")
})

test("a structured file that will NOT parse answers its own text, never a throw", () => {
    // Half a file at rest is a fact. A build reading configuration is better served by
    // the raw text — which it can print — than by an exception three layers up. And the
    // door reads `undefined` as "nothing here", so answering text is also what keeps a
    // broken file distinguishable from an absent one.
    const v = vocabulary({})
    assert.equal(v.parse(encode("{ not json"), "x.json"), "{ not json")
    assert.equal(v.parse(encode('"unterminated'), "x.json"), '"unterminated')
})

test("the EDGES are ports: a suffix only this host calls text", () => {
    const mine = vocabulary({ extensions: ["hash"] })
    assert.equal(mine.isText("x.hash"), true)
    assert.equal(vocabulary({}).isText("x.hash"), false, "and it is not text for everybody")
    assert.ok(mine.TEXT.includes("json"), "the shared list is still there")
    assert.ok(mine.TEXT.includes("hash"))
})

test("and a format whose PARSER the host ships — YAML is the case that proves it", () => {
    // The package that reads YAML is fine in either realm, but a PAGE only has it if
    // the host's build shipped its bytes, and what a host ships is not this door's
    // business. With no codec the format falls back to TEXT, which is the honest
    // answer rather than a throw.
    const bare = vocabulary({})
    assert.equal(bare.parse(encode("key: value"), "x.yaml"), "key: value", "no codec, no guess")

    const wired = vocabulary({ codecs: { yaml: { parse: () => ({ from: "the host" }), stringify: () => "from: the host" } } })
    assert.deepEqual(wired.parse(encode("key: value"), "x.yaml"), { from: "the host" })
    assert.equal(text(wired.stringify({ any: "thing" }, "x.yaml")), "from: the host")
})

test("stringify is the mirror, and JSON is indented for people", () => {
    // A one-line JSON diff says nothing about which key changed.
    const v = vocabulary({})
    assert.equal(text(v.stringify({ a: 1 }, "x.json")), '{\n    "a": 1\n}\n')
    assert.equal(text(v.stringify([{ a: 1, b: 2 }], "x.csv")).split("\n")[0], "a,b")
    assert.equal(text(v.stringify("plain", "x.txt")), "plain")
    const raw = new Uint8Array([1, 2, 3])
    assert.deepEqual(v.stringify(raw, "x.bin"), raw, "bytes pass straight through")
})

test("a round trip through both halves keeps the document", () => {
    const v = vocabulary({})
    for (const [name, document] of [
        ["x.json", { a: 1, b: [2, 3] }],
        ["x.csv", [{ a: "1", b: "2" }]],
        ["x.tsv", [{ a: "1", b: "2" }]]
    ])
        assert.deepEqual(v.parse(v.stringify(document, name), name), document, name)
})

test("the registry ENFORCES both edge shapes — a declared shape nothing checks is a lie", () => {
    // `array` and `object` arrived with this door. A shape the table declares and the
    // checker ignores is a declaration narrower than its own law.
    assert.throws(() => vocabulary({ extensions: "hash" }), /array/)
    assert.throws(() => vocabulary({ codecs: [] }), /plain object/)
    assert.doesNotThrow(() => vocabulary({ extensions: [], codecs: {} }))
})
