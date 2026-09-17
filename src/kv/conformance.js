import { PORTS, requires } from "../contract.js"

/**
 * Does this chain-store BEHAVE the way the doors above it expect?
 *
 * The registry checks that a store has `get` and `del`. That is two methods and
 * it is nowhere near what `createDB().lives` and the `kv` engine of
 * `collections` actually rely on: they chain `get(a).get(b)`, they pass an
 * ARRAY to `get`, they read `once()`, they enumerate with `map(callback)` and
 * they expect the callback's second argument to be a path whose last segment is
 * the document's id. None of that was written down — it lived in what those two
 * engines happened to do — so a host wiring its own store found the gaps by
 * having a collection come back empty.
 *
 * Exported for the same reason `checkDriver` is: the store lives in the host.
 * akao injects the one it already had, and now it can ask this package whether
 * that store answers the questions this package asks.
 *
 * It WRITES under `at` and removes what it wrote. A store that cannot be written
 * to cannot be checked.
 */
export async function checkStore(store, { at = "udb-conformance" } = {}) {
    requires(store, PORTS.store.methods, "store", "checkStore()")

    const broken = []
    const check = (ok, promise) => {
        if (!ok) broken.push(promise)
    }
    const root = () => store.get(at)

    try {
        await store.ready

        // ── absence is an answer ────────────────────────────────────────────
        try {
            const missing = await root().get("nothing").once()
            check(missing === undefined || missing === null, "once() of a path with nothing there must answer undefined (or null), not throw")
        } catch {
            check(false, "once() THREW for a path with nothing there — a read is a question, and absence is one of its answers")
        }

        // ── a document goes in and comes back ───────────────────────────────
        await root().get("one").put({ id: "one", n: 1 })
        const read = await root().get("one").once()
        check(read?.n === 1, "once() must return the document put() was given")

        // ── an ARRAY key is the same node as a chain ────────────────────────
        const sugared = await store.get([at, "one"]).once()
        check(sugared?.n === 1, "get(['a','b']) must land on the same node as get('a').get('b') — the doors above use both spellings")

        // ── a node may hold a value AND have children ───────────────────────
        await root().get("one").get("deeper").put({ id: "deeper", n: 2 })
        check((await root().get("one").once())?.n === 1, "a node that gained a child must still hold its own value")
        check((await root().get("one").get("deeper").once())?.n === 2, "and the child must be readable")

        // ── map enumerates the CHILDREN, and names them ─────────────────────
        await root().get("two").put({ id: "two", n: 3 })
        const seen = []
        await root().map((document, path) => {
            seen.push([Array.isArray(path) ? path.at(-1) : path, document?.n])
        })
        const names = seen.map(([name]) => name)
        check(names.includes("one") && names.includes("two"), `map() must visit every child document — saw ${JSON.stringify(names)}`)
        check(
            seen.every(([name, n]) => typeof name === "string" && n !== undefined),
            "map() must hand the callback (document, path) with a path whose LAST segment is the id — the collections engine keys its rows off exactly that"
        )

        // ── a subscriber hears a write that has SETTLED ─────────────────────
        const heard = []
        // AWAITED: a port method may be async, and this one usually is — a store
        // that reads the current value before it registers the subscriber has to
        // be, and both known implementations do exactly that. A kit that
        // subscribes without waiting races the very write it is about to make,
        // and then reports the store as deaf. (It did, against a real host, the
        // hour it shipped.)
        const stop = await root().get("watched").on((value) => heard.push(value))
        await root().get("watched").put({ id: "watched", n: 4 })
        check(
            heard.some((value) => value?.n === 4),
            "on() must deliver a write to this realm's subscribers — the lives mount is a fan-out and a store that stays silent makes it a no-op"
        )
        if (typeof stop === "function") stop()

        // ── delete means gone ───────────────────────────────────────────────
        await root().get("two").del()
        check((await root().get("two").once()) === undefined, "del() must make a document unreadable afterwards")

        // ── the store can be emptied, the way the door empties it ───────────
        // `del([])` with the EMPTY PATH, because that is the call `DB.wipe()`
        // makes — `lives.store.del([])`. The first version of this kit called
        // `del()` with no argument and reported a perfectly good store as
        // keeping its rows: the kit was asking a question the doors never ask.
        await store.del([])
        check((await root().get("one").once()) === undefined, "del([]) must empty the whole store — DB.wipe() is that call, and a store that keeps its rows makes a wipe a lie")
    } finally {
        // Same rule as the driver kit: await, never `.catch()` on the answer.
        // A store whose `del` is synchronous is conformant, and a kit that
        // crashes on it reports a crash where it owes a verdict.
        try {
            await store.get(at).del?.([])
        } catch {
            // cleaning up is a courtesy, not a verdict
        }
    }

    if (broken.length) throw new Error(`UDB: this chain-store has the methods the port names and does not keep ${broken.length} of its promises:\n  - ${broken.join("\n  - ")}`)
    return true
}

export default checkStore
