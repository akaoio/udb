/**
 * REAL machinery for the suite — the answer to "stubs assume unreality".
 *
 * Everything here is the genuine article, zero dependencies:
 *   sqlite()    — node:sqlite (a real SQLite with JSON1), adapted to the
 *                 exec/run/get/all handle the browser engine expects. The
 *                 compile() side of the filter language runs against REAL
 *                 SQL in this repo, not only in a host's browser tier.
 *   diskDriver  — node:fs under a throwaway root: real files, real
 *                 directories, real ENOENT.
 *   contentHash — a real SHA-1 digest over (name ‖ 0 ‖ bytes) via WebCrypto.
 *                 The engine's contract is equality of a content address —
 *                 the algorithm is the host's choice (akao uses BEP3); what
 *                 must be real is that it derives from the actual bytes.
 *
 * The ONE remaining double is the kv chain-store (stubs.js): that is a
 * documented CONTRACT stand-in — its real implementation is the host's
 * (akao pins it against real IndexedDB in its conformance tier).
 */
import { nodeDatabase } from "../src/sqlite/node.js"
import { mkdtempSync, promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { webcrypto } from "node:crypto"
import { nodeDriver } from "../src/driver/node.js"

/**
 * A real in-memory database, through the package's OWN engine.
 *
 * This used to be a hand-written handle over `node:sqlite` — a second
 * implementation of the shape `collections` consumes, living in the test folder,
 * which is exactly the kind of copy that agrees on the day it is written. Since
 * 0.4.0 the engine is part of the package, so the suite uses it.
 */
export function sqlite() {
    return nodeDatabase({ path: ":memory:" })
}

export function diskRoot() {
    return mkdtempSync(join(tmpdir(), "UDB-real-"))
}

// The node driver is the PACKAGE's now (src/driver/node.js). This helper was
// where it lived while it was "just a test fixture", which was the evidence that
// every host was writing it again — #5.
export const diskDriver = (root) => nodeDriver({ root })

const encoder = new TextEncoder()

export async function contentHash(bytes, name = "") {
    const nameBytes = encoder.encode(name)
    const joined = new Uint8Array(nameBytes.length + 1 + bytes.length)
    joined.set(nameBytes, 0)
    joined.set(bytes, nameBytes.length + 1)
    const digest = new Uint8Array(await webcrypto.subtle.digest("SHA-1", joined))
    return { v1: [...digest].map((b) => b.toString(16).padStart(2, "0")).join("") }
}

export const encode = (text) => encoder.encode(text)
