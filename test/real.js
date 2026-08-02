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
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { webcrypto } from "node:crypto"

export function sqlite() {
    const db = new DatabaseSync(":memory:")
    return {
        exec: async (sql) => db.exec(sql),
        run: async (sql, params = []) => db.prepare(sql).run(...params),
        get: async (sql, params = []) => db.prepare(sql).get(...params),
        all: async (sql, params = []) => db.prepare(sql).all(...params)
    }
}

export function diskRoot() {
    return mkdtempSync(join(tmpdir(), "udb-real-"))
}

export function diskDriver(root) {
    const at = (path) => join(root, ...path)
    return {
        readBytes: async (path) => {
            try {
                return new Uint8Array(await fs.readFile(at(path)))
            } catch {
                return null
            }
        },
        writeBytes: async (path, bytes) => {
            await fs.mkdir(dirname(at(path)), { recursive: true })
            await fs.writeFile(at(path), bytes)
        },
        remove: async (path) => fs.rm(at(path), { recursive: true, force: true }),
        entries: async (path) => (await fs.readdir(at(path), { withFileTypes: true })).map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
    }
}

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
