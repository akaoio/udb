import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sqlite, engine, VERBS, LOCAL_ONLY } from "../src/sqlite/index.js"
import { nodeDatabase } from "../src/sqlite/node.js"
import { wasmDatabase } from "../src/sqlite/wasm.js"
import { remoteDatabase } from "../src/sqlite/remote.js"
import { statements } from "../src/sqlite/statements.js"

const HERE = mkdtempSync(join(tmpdir(), "udb-sqlite-"))
const fresh = (file = "t.db") => nodeDatabase({ path: join(HERE, file) })

test("statements counts what SQLite would run, and a `;` in a literal or a comment is not one", () => {
    for (const [sql, want] of [
        ["SELECT 1", 1],
        ["CREATE TABLE a(x); CREATE TABLE b(y)", 2],
        ["SELECT 1;", 1],
        ["", 0],
        ["-- only a comment", 0],
        [";;;", 0],
        ["SELECT 'a;b'", 1],
        ["SELECT ''';'", 1],
        ['SELECT "a;b" FROM t', 1],
        ["SELECT 1 -- ; not a statement", 1],
        ["SELECT 1 /* ; */ ; SELECT 2", 2]
    ]) {
        assert.equal(statements(sql), want, `statements(${JSON.stringify(sql)})`)
    }
})

test("every statement of a multi-statement exec really runs — the platform drops all but the first", async () => {
    // node:sqlite measured on v24.21: prepare("CREATE TABLE a(x); CREATE TABLE b(y)").all()
    // creates only `a`, with no error. The door must not inherit that.
    const db = fresh("multi.db")
    await db.exec("CREATE TABLE a(x); CREATE TABLE b(y)")
    const names = (await db.all("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name", ["table"])).map((row) => row.name)
    assert.deepEqual(names, ["a", "b"], "both tables exist")
    await db.close()
})

test("several statements WITH parameters are refused by name rather than half-run", async () => {
    const db = fresh("refuse.db")
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    await assert.rejects(() => db.exec("INSERT INTO t VALUES (?); INSERT INTO t VALUES (?)", [1, 2]), /more than one statement AND takes parameters/)
    // And the row-returning verbs have no script door at all, so for them a
    // second statement is always an error — never a first-statement-only run.
    await assert.rejects(() => db.get("SELECT 1; SELECT 2"), /get\(\) prepares/)
    await assert.rejects(() => db.run("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)"), /run\(\) prepares/)
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM t")).total, 0, "and nothing ran")
    await db.close()
})

test("the verbs answer the shapes the contract states", async () => {
    const db = fresh("shapes.db")
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)")
    assert.deepEqual(await db.exec("INSERT INTO t (val) VALUES ('a')"), [], "a write answers with no rows")
    const written = await db.run("INSERT INTO t (val) VALUES (?)", ["b"])
    assert.deepEqual(written, { changes: 1, lastId: 2 }, "run answers changes and the new rowid")
    assert.deepEqual(await db.get("SELECT val FROM t WHERE id = ?", [1]), { val: "a" })
    assert.equal(await db.get("SELECT val FROM t WHERE id = ?", [99]), null, "a miss is null, not undefined — node:sqlite answers undefined and the door normalises it")
    assert.deepEqual((await db.all("SELECT val FROM t ORDER BY id")).map((row) => row.val), ["a", "b"])
    assert.deepEqual(await db.get("SELECT $n AS n", { n: 5 }), { n: 5 }, "named parameters pass through as one object")
    await db.close()
})

test("rows carry an ordinary prototype — the two engines must answer the same TYPE", async () => {
    // node:sqlite answers null-prototype objects and the WASM engine answers
    // ordinary ones. Left alone, `deepStrictEqual` and anything reading a method
    // off Object.prototype would behave differently per realm — which is the
    // difference this door exists to remove.
    const db = fresh("proto.db")
    const one = await db.get("SELECT 1 AS n")
    assert.equal(Object.getPrototypeOf(one), Object.prototype)
    assert.deepEqual(one, { n: 1 }, "so a plain object literal compares equal")
    const many = await db.all("SELECT 1 AS n UNION ALL SELECT 2")
    assert.ok(
        many.every((row) => Object.getPrototypeOf(row) === Object.prototype),
        "every row, not just the first"
    )
    await db.close()
})

test("a transaction commits its work, and a throw leaves NOTHING behind", async () => {
    const db = fresh("tx.db")
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)")
    const answer = await db.transaction((tx) => {
        tx.run("INSERT INTO t (val) VALUES (?)", ["one"])
        tx.run("INSERT INTO t (val) VALUES (?)", ["two"])
        return tx.get("SELECT COUNT(*) AS total FROM t").total
    })
    assert.equal(answer, 2, "the body's value comes back")

    await assert.rejects(() =>
        db.transaction((tx) => {
            tx.run("INSERT INTO t (val) VALUES (?)", ["three"])
            throw new Error("changed my mind")
        })
    , /changed my mind/)
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM t")).total, 2, "the failed transaction rolled back")
    await db.close()
})

test("a transaction body that returns a promise is refused, and rolls back", async () => {
    // The hazard this rule exists for: an await between BEGIN and COMMIT hands
    // the event loop away with the transaction open, and anything else on this
    // connection lands inside it.
    const db = fresh("async-tx.db")
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    await assert.rejects(() =>
        db.transaction(async (tx) => {
            tx.run("INSERT INTO t VALUES (1)")
        })
    , /must be synchronous/)
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM t")).total, 0, "nothing survived the refusal")
    await db.close()
})

test("batch is one transaction — a failure in the middle leaves the first statements undone", async () => {
    const db = fresh("batch.db")
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT NOT NULL)")
    const answers = await db.batch([
        { sql: "INSERT INTO t (val) VALUES (?)", params: ["a"] },
        { sql: "SELECT COUNT(*) AS total FROM t" }
    ])
    assert.deepEqual(answers[1], [{ total: 1 }], "each query answers in order")

    await assert.rejects(() =>
        db.batch([
            { sql: "INSERT INTO t (val) VALUES (?)", params: ["b"] },
            { sql: "INSERT INTO t (val) VALUES (?)", params: [null] } // NOT NULL
        ])
    )
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM t")).total, 1, "the whole batch rolled back")
    await db.close()
})

test("the pragmas are the CALLER's — the engine states none of its own on Node", async () => {
    const path = join(HERE, "pragma.db")
    const db = nodeDatabase({ path, pragmas: ["journal_mode=WAL", "busy_timeout=5000"] })
    assert.equal((await db.get("PRAGMA journal_mode")).journal_mode, "wal")
    assert.equal((await db.get("PRAGMA busy_timeout")).timeout, 5000)
    await db.close()
    assert.ok(existsSync(path), "the file is on disk, which is the whole point of this engine")

    const plain = nodeDatabase({ path: join(HERE, "plain.db") })
    assert.notEqual((await plain.get("PRAGMA journal_mode")).journal_mode, "wal", "no pragma asked, none applied — a durability policy belongs to whoever owns the directory")
    await plain.close()
})

test("a prepared statement is held by the caller, and answers the same shapes", async () => {
    const db = fresh("prepared.db")
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)")
    const insert = db.prepare("INSERT INTO t (val) VALUES (?)")
    assert.deepEqual(insert.run("a"), { changes: 1, lastId: 1 })
    assert.deepEqual(insert.run("b"), { changes: 1, lastId: 2 }, "the same statement runs again — that is the whole point")
    const one = db.prepare("SELECT val FROM t WHERE id = ?")
    assert.deepEqual(one.get(1), { val: "a" }, "variadic, like every SQLite binding")
    assert.equal(one.get(99), null, "a miss is null here too")
    assert.equal(Object.getPrototypeOf(one.get(1)), Object.prototype, "and the row type matches the other verbs")
    assert.deepEqual(
        db.prepare("SELECT val FROM t ORDER BY id").all().map((row) => row.val),
        ["a", "b"]
    )
    insert.finalize()
    await db.close()
})

test("a prepared statement refuses a second statement, like every verb that prepares", async () => {
    const db = fresh("prepared-multi.db")
    assert.throws(() => db.prepare("SELECT 1; SELECT 2"), /prepare\(\) prepares/)
    await db.close()
})

test("the synchronous face is the SAME functions a transaction body gets", async () => {
    const db = fresh("sync-face.db")
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)")
    db.sync.run("INSERT INTO t (val) VALUES (?)", ["a"])
    assert.deepEqual(db.sync.get("SELECT val FROM t WHERE id = ?", [1]), { val: "a" })
    assert.deepEqual(db.sync.all("SELECT val FROM t"), [{ val: "a" }])
    assert.deepEqual(db.sync.exec("INSERT INTO t (val) VALUES ('b')"), [])
    await db.close()
})

test("a local engine declares what it can do, and the remote one refuses both BY NAME", async () => {
    const local = await sqlite({ path: join(HERE, "local.db") })
    for (const verb of LOCAL_ONLY) assert.ok(local[verb], `a local engine offers ${verb}`)
    await local.close()

    const remote = await sqlite({ dispatch: async () => ({}) })
    assert.throws(() => remote.prepare("SELECT 1"), /a statement is a handle inside the database/)
    assert.throws(() => remote.sync, /no synchronous face across a transport/)
})

test("a closed handle refuses rather than reopening silently", async () => {
    const db = fresh("closed.db")
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)")
    await db.close()
    await assert.rejects(() => db.get("SELECT 1"))
})

test("the door picks the engine from what the realm HAS", async () => {
    // Async because the engine a realm cannot run must never be imported: a
    // static import of node.js would fail to resolve `node:sqlite` in a browser
    // and take the whole import chain down with it.
    const local = await sqlite({ path: join(HERE, "door.db") })
    assert.equal(local.local, true, "Node gets an engine that runs the statements itself")
    for (const verb of VERBS) assert.equal(typeof local[verb], "function", `the Node engine answers ${verb}`)
    await local.close()

    const remote = await sqlite({ dispatch: async () => ({}) })
    assert.equal(remote.local, false, "a dispatch means the database is somewhere else")
    for (const verb of VERBS) assert.equal(typeof remote[verb], "function", `the remote handle answers ${verb}`)
})

test("an engine is resolved ONCE and opens databases synchronously after that", async () => {
    // The split exists because a store that opens a database per symbol, lazily,
    // from inside synchronous readers cannot await — and making it await moves
    // that await into every call site beneath it.
    const open = await engine()
    const first = open({ path: join(HERE, "one.db") })
    const second = open({ path: join(HERE, "two.db") })
    assert.notEqual(first, second, "two databases from one engine")
    assert.equal(typeof first.prepare, "function", "and the handle is the same shape the door hands back")
    await first.exec("CREATE TABLE a (x)")
    await second.exec("CREATE TABLE b (x)")
    assert.deepEqual((await first.all("SELECT name FROM sqlite_master")).map((row) => row.name), ["a"], "each one is its own file")
    await first.close()
    await second.close()

    const remote = (await engine({ dispatch: async () => ({}) }))({ name: "akao" })
    assert.equal(remote.local, false, "the remote engine resolves the same way and also opens synchronously")
})

test("a remote handle opens before its first query and carries the database name", async () => {
    const asked = []
    const db = remoteDatabase({ dispatch: async (method, params) => (asked.push([method, params]), method === "all" ? [{ n: 1 }] : {}), name: "akao" })
    assert.deepEqual(await db.all("SELECT 1"), [{ n: 1 }])
    assert.deepEqual(asked[0], ["open", { db: "akao" }], "the open comes first — a query that raced it used to fail with 'database not open'")
    assert.deepEqual(asked[1], ["all", { db: "akao", sql: "SELECT 1", params: undefined }])
})

test("a remote handle refuses transaction BY NAME and points at batch", async () => {
    const db = remoteDatabase({ dispatch: async () => ({}) })
    await assert.rejects(() => db.transaction(() => {}), /not available across a transport[\s\S]*batch/)
})

test("the WASM engine refuses a context it would silently forget everything in", () => {
    assert.throws(() => wasmDatabase({}), /needs an initialised sqlite3 module/)
    assert.throws(() => wasmDatabase({ sqlite3: { oo1: {} } }), /no OPFS VFS/)
})

process.on("exit", () => rmSync(HERE, { recursive: true, force: true }))
