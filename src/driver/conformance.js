import { PORTS, requires } from "../contract.js"

/**
 * Does this driver BEHAVE like the port says? — a kit a host runs on its own.
 *
 * `conform()` in contract.js checks SHAPE: the four methods are there and the
 * scope is a non-empty string. Shape is not meaning. A driver whose `readBytes`
 * throws on a missing file has every method and still breaks the statics engine,
 * which asks "is there an at-rest copy" on every read and reads a throw as a
 * fault rather than as "no". A driver whose `remove` fails on something already
 * gone turns an idempotent cleanup into an error a caller never expected.
 *
 * Those meanings were written down nowhere: they lived in what this package's
 * engines happened to expect, so every host implementing a driver discovered
 * them by breaking. This function is the other half of the contract, and it is
 * exported because the host is where the driver lives — akao runs it against the
 * ten-verb file door it injects, in its own suite, in milliseconds.
 *
 * It WRITES: give it a scratch subtree it may destroy. It cleans up after
 * itself, and it says which promise was broken rather than which line failed.
 */
export async function checkDriver(driver, { at = ["udb-conformance"] } = {}) {
    requires(driver, PORTS.driver.methods, "driver", "checkDriver()", PORTS.driver.fields)

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const file = [...at, "one.json"]
    const nested = [...at, "deep", "two.json"]
    const broken = []
    const check = (ok, promise) => {
        if (!ok) broken.push(promise)
    }

    try {
        await driver.remove(at)

        // ── absence is an ANSWER ────────────────────────────────────────────
        let missing
        try {
            missing = await driver.readBytes(file)
            check(missing === null || missing === undefined || missing.length === 0, "readBytes() of a path with nothing there must answer null (or empty), not throw — the statics engine asks this on every read")
        } catch {
            check(false, "readBytes() THREW for a path with nothing there — absence is an answer, and a throw makes a normal miss look like a fault")
        }
        try {
            check((await driver.entries([...at, "nowhere"])).length === 0, "entries() of a directory that does not exist must answer [] — walking is a statement about what IS there")
        } catch {
            check(false, "entries() THREW for a directory that does not exist — walking is a statement about what IS there, so it answers []")
        }
        try {
            await driver.remove([...at, "nowhere"])
        } catch {
            check(false, "remove() THREW for something that was not there — the caller asked for it to be gone, and it is gone")
        }

        // ── a write, read back verbatim ─────────────────────────────────────
        const body = encoder.encode('{"conformance":true}')
        await driver.writeBytes(file, body)
        const read = await driver.readBytes(file)
        check(read && decoder.decode(read) === '{"conformance":true}', "readBytes() must return exactly the bytes writeBytes() was given")

        // ── parents are the driver's job ────────────────────────────────────
        try {
            await driver.writeBytes(nested, body)
            const deep = await driver.readBytes(nested)
            check(deep && deep.length === body.length, "writeBytes() must create the parent directories — a caller writing a/b/c.json is saying where the file goes, not promising the directories exist")
        } catch {
            check(false, "writeBytes() THREW for a path whose parent did not exist — creating the parents is the driver's job")
        }

        // ── entries says what is there, and which of them is a directory ────
        const listed = await driver.entries(at)
        const names = listed.map((entry) => entry?.name ?? entry)
        check(names.includes("one.json"), "entries() must list a file that was just written")
        check(names.includes("deep"), "entries() must list a directory that was just created")
        const directory = listed.find((entry) => (entry?.name ?? entry) === "deep")
        check(directory?.isDir === true, "entries() must mark a directory with isDir: true — the walk descends on that field alone, so without it a tree looks flat and every subtree is silently skipped")
        const plain = listed.find((entry) => (entry?.name ?? entry) === "one.json")
        check(!plain?.isDir, "entries() must NOT mark a file as a directory")

        // ── a FILE is not an empty directory ───────────────────────────────
        // The promise this kit did not ask for until 2026-09-17, and its absence
        // let a driver turn every file in a host's tree into a directory: that
        // host tested "is this a directory" by LISTING it and checking the answer
        // was an array, which is correct against a driver that throws and wrong
        // against one that answers `[]`. Its build stopped with "carries
        // configs.yaml AND the subdirectories configs.yaml, pools.yaml" — a
        // sentence that cannot be true.
        try {
            await driver.entries(file)
            check(false, "entries() of a path that is a FILE must be refused, not answered with [] — an empty list is how a caller mistakes a file for an empty directory")
        } catch {
            // refused, which is the promise
        }
        try {
            check((await driver.entries([...at, "nowhere"])).length === 0, "while a directory that does not EXIST still answers [] — the two are different questions")
        } catch {
            check(false, "entries() of a directory that does not exist must answer [], not throw")
        }

        // ── remove takes the subtree with it ────────────────────────────────
        await driver.remove(at)
        let afterwards = null
        try {
            afterwards = await driver.readBytes(nested)
        } catch {
            afterwards = null // a driver that throws on a miss is already reported above
        }
        check(afterwards === null || afterwards === undefined || afterwards.length === 0, "remove() must take the whole subtree, not just the top entry")
    } finally {
        // `await` rather than `.catch()` on the return value: a port method may
        // be synchronous — the contract says "a function", not "a function that
        // returns a promise" — and calling `.catch` on what a sync `remove`
        // answers with is a TypeError from inside this kit, which reports a
        // crash where it owes a verdict. Found by running it against a real
        // host's driver the day it shipped.
        try {
            await driver.remove(at)
        } catch {
            // cleaning up is a courtesy, not a verdict
        }
    }

    if (broken.length) throw new Error(`UDB: this driver has every method the port names and does not keep ${broken.length} of its promises:\n  - ${broken.join("\n  - ")}`)
    return true
}

/**
 * The SIX verbs beyond the port — for a driver that offers a whole file door.
 *
 * The port demands four, because four is what this package calls. A host with a
 * file layer of its own needs `list exists isDir mkdir move copyFile`, and this
 * package ships them (`nodeDriver`, `opfsDriver`) so the host stops writing them
 * over the same backend. Anything shipped needs its meaning stated, and OPFS is
 * where the meanings are least obvious: there is no stat and no rename, so
 * `isDir` is a directory-open attempt and `move` is copy-then-remove.
 *
 * Optional on purpose: a driver that answers only the port's four is CONFORMANT.
 * This is the extra promise, asked of the drivers that make it.
 */
export async function checkFileDoor(driver, { at = ["udb-file-door"] } = {}) {
    const extra = ["list", "exists", "isDir", "mkdir", "move", "copyFile"]
    const missing = extra.filter((verb) => typeof driver[verb] !== "function")
    if (missing.length) throw new Error(`UDB: this driver offers no file door — ${missing.map((verb) => `${verb}()`).join(", ")} missing. The PORT needs only ${PORTS.driver.methods.join(", ")}, so this is a check to run on a driver that claims more.`)

    const encoder = new TextEncoder()
    const broken = []
    const check = (ok, promise) => {
        if (!ok) broken.push(promise)
    }

    try {
        await driver.remove(at)
        await driver.writeBytes([...at, "one.json"], encoder.encode("{}"))

        check((await driver.exists([...at, "one.json"])) === true, "exists() must answer true for a file that is there")
        check((await driver.exists([...at, "nope.json"])) === false, "and false for one that is not — not throw, and not a truthy handle")
        check((await driver.isDir(at)) === true, "isDir() must answer true for a directory")
        check((await driver.isDir([...at, "one.json"])) === false, "and FALSE for a file — on a store with no stat, asking is opening the name as a directory, which THROWS rather than answering")
        check((await driver.list(at)).includes("one.json"), "list() must name what is in a directory")

        await driver.mkdir([...at, "made"])
        check((await driver.isDir([...at, "made"])) === true, "mkdir() must create a directory that was not there — an empty one, which no write can express")

        await driver.copyFile([...at, "one.json"], [...at, "made", "two.json"])
        check((await driver.exists([...at, "made", "two.json"])) === true, "copyFile() must create the copy, parents included")
        check((await driver.exists([...at, "one.json"])) === true, "and must leave the original where it was")

        await driver.move([...at, "made", "two.json"], [...at, "made", "three.json"])
        check((await driver.exists([...at, "made", "three.json"])) === true, "move() must create the destination, parents included")
        check((await driver.exists([...at, "made", "two.json"])) === false, "and the source must be GONE — a move that leaves both is a copy with a wrong name")
    } finally {
        try {
            await driver.remove(at)
        } catch {
            // cleaning up is a courtesy, not a verdict
        }
    }

    if (broken.length) throw new Error(`UDB: this file door does not keep ${broken.length} of its promises:\n  - ${broken.join("\n  - ")}`)
    return true
}

export default checkDriver
