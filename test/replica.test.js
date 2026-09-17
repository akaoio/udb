import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Replica, configFor, databasesIn, resolveBinary, idOf, REPLICATED_PRAGMAS, BUSY_MS } from "../src/replica/index.js"

/**
 * Replication — the parts that are THIS package's, tested without the binary.
 *
 * What needs a live Litestream (a real ship-and-restore cycle) is a host's
 * acceptance suite, because it needs a destination and credentials. What is
 * asked here is everything that is this module's own law: what a config says,
 * what counts as a database, what is refused, and the promise that a machine
 * without the binary is turned OFF rather than taken down.
 */
const S3 = (id) => [{ type: "s3", bucket: "markets", path: `zone/${id}`, endpoint: "https://acct.example.com", region: "auto" }]

function tree(files = ["alerts.db", "cex-BTC.db", "alerts.db-wal", "alerts.db-shm", "notes.txt", "litestream.yml"]) {
    const dir = mkdtempSync(join(tmpdir(), "udb-replica-"))
    for (const name of files) writeFileSync(join(dir, name), "")
    return dir
}

test("a directory is the unit: only databases are listed, sorted, and a missing one is empty rather than a throw", () => {
    const dir = tree()
    try {
        assert.deepEqual(databasesIn(dir), ["alerts.db", "cex-BTC.db"])
        assert.deepEqual(databasesIn(join(dir, "nowhere")), [])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("the config names every database by its own path, and every destination the host answered with", () => {
    const dir = tree()
    try {
        const yaml = configFor(dir, databasesIn(dir), S3)
        assert.match(yaml, new RegExp(`- path: ${resolve(dir)}/alerts\\.db`))
        assert.match(yaml, new RegExp(`- path: ${resolve(dir)}/cex-BTC\\.db`))
        assert.match(yaml, /path: zone\/alerts/)
        assert.match(yaml, /path: zone\/cex-BTC/)
        // Per database, never per directory: two databases shipping to one prefix
        // overwrite each other's generations, and it surfaces only at a restore.
        assert.notEqual(yaml.indexOf("zone/alerts"), yaml.lastIndexOf("zone/cex-BTC"))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a host may use ANY backend Litestream has — this module places entries, it does not know a taxonomy", () => {
    const dir = tree(["one.db"])
    try {
        const yaml = configFor(dir, ["one.db"], (id) => [{ url: `file:///backups/${id}` }, { type: "sftp", host: "box.example.com", path: `/srv/${id}` }])
        assert.match(yaml, /url: file:\/\/\/backups\/one/)
        assert.match(yaml, /type: sftp/)
        assert.match(yaml, /path: \/srv\/one/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a credential is REFUSED rather than written — a config file is a thing people paste into issues", () => {
    const dir = tree(["one.db"])
    try {
        assert.throws(() => configFor(dir, ["one.db"], () => [{ type: "s3", bucket: "b", "access-key-id": "AKIA…" }]), /credentials belong in the environment/)
        assert.throws(() => configFor(dir, ["one.db"], () => [{ type: "s3", bucket: "b", secretAccessKey: "…" }]), /credentials belong in the environment/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("a database with NO destination is refused — it would be believed to be backed up and would not be", () => {
    const dir = tree(["one.db"])
    try {
        assert.throws(() => configFor(dir, ["one.db"], () => []), /answered with an empty list/)
        assert.throws(() => configFor(dir, ["one.db"], () => null), /answered with object/)
        assert.throws(() => configFor(dir, ["one.db"], () => [{}]), /empty object/)
        assert.throws(() => configFor(dir, ["one.db"], () => [{ type: "s3", nested: { a: 1 } }]), /must be a string, number or boolean/)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("the seam is checked at wiring: no replicas port, no replica", () => {
    assert.throws(() => new Replica({ name: "z", dir: "/tmp" }), /needs replicas to be a function/)
    assert.throws(() => new Replica({ dir: "/tmp", replicas: S3 }), /needs a NAME/)
    assert.throws(() => new Replica({ name: "z", replicas: S3 }), /needs a directory/)
})

test("a binary that will not run is not accepted as one, and a NAMED one is never silently replaced", () => {
    assert.equal(resolveBinary("definitely-not-a-binary-anywhere"), null)
    assert.equal(resolveBinary(null, { candidates: ["./nothing-here"], name: "definitely-not-on-path" }), null)
})

test("no binary turns replication OFF and does NOT take the host down", () => {
    const dir = tree(["one.db"])
    const said = []
    try {
        const replica = new Replica({ name: "zone", dir, replicas: S3, binary: "definitely-not-a-binary-anywhere", log: { log: (...a) => said.push(a.join(" ")), warn: (...a) => said.push(a.join(" ")) } })
        assert.equal(replica.enabled, false)
        assert.doesNotThrow(() => replica.start())
        assert.deepEqual(replica.replicating, [], "and it does not claim to be backing anything up")
        assert.ok(
            said.some((line) => /replication is OFF/.test(line)),
            `it must SAY so — said: ${said.join(" | ")}`
        )
        assert.equal(existsSync(join(dir, "litestream.yml")), false, "and it writes no config it is not acting on")
        replica.close()
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test("the open policy travels with the capability, and carries its measurement", () => {
    // A replicator is not a reader: it takes the write lock to create its own
    // tables. Measured with litestream 0.5.16: busy_timeout=0 threw on 5.8% of
    // writes, busy_timeout=5000 on none.
    assert.deepEqual(REPLICATED_PRAGMAS, ["journal_mode=WAL", `busy_timeout=${BUSY_MS}`])
    assert.equal(BUSY_MS, 5000)
})

test("ids are the file name without the extension — the address in a bucket is derivable", () => {
    assert.equal(idOf("alerts.db"), "alerts")
    assert.equal(idOf("cex-binance-BTCUSDT.db"), "cex-binance-BTCUSDT")
})
