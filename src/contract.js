/**
 * THE SEAM between UDB and a host: every port, in one place.
 *
 * ── The law this file exists to make mechanical ─────────────────────────────
 *
 * **A capability has ONE owner. The other side touches it only through a port
 * declared here. When the host must influence an owned capability, that
 * influence arrives as PARAMETERS through the port — never as a second half of
 * the implementation.**
 *
 * The owner of a capability is the side that can state its law WITHOUT naming
 * the other side. "How to run SQL in this realm" is statable without naming
 * akao, so the engine is UDB's (0.10.0). "Which bucket these bytes replicate
 * to" names a host's deployment, so it is the host's — and it reaches UDB as an
 * argument, not as a module living over there.
 *
 * That last sentence is the one that was missing. Without it every new
 * capability was re-argued from scratch, and the argument was always about lines
 * of code rather than about ownership — so the answer was always "split it", and
 * a split capability is a capability with half a body in each repository. Two
 * homes, no arbiter, which is the expensive failure this package was extracted
 * to end.
 *
 * ── Why a REGISTRY and not a checker per call site ──────────────────────────
 *
 * Measured 2026-09-17, before this file grew: UDB had EIGHT real seams and
 * checked six of them. `collections({ sql, kv })` checked nothing at all — a
 * host that injected something that is not a function got `sql is not a
 * function` from inside `sqlEngine`, and a host that injected NEITHER got a
 * refusal only at the first `collectionMount(name)`, which is a different moment
 * from wiring and often a different stack. Each mount also spelled its own list
 * of what it needs, so "which ports does UDB have" had three homes and no
 * answer: the question a host asks first is the one thing this package could not
 * be asked.
 *
 * Now the mounts ask this table. A port added here is checked the same hour by
 * every mount that names it, and a host reading one file learns the whole seam.
 *
 * ── What a host injects, and what UDB needs from it ─────────────────────────
 *
 * ── The failure this removes ────────────────────────────────────────────────
 *
 * Every engine here arrives from the host, and until now nothing said what shape
 * it had to have. A host that wired a driver with three of the four methods got
 * no complaint at `createDB`: it got `TypeError: driver.entries is not a
 * function` later, from inside a read, with a stack through this package and a
 * cause in the caller's own wiring. Same for a `lives` store without `del`, or a
 * `statics` engine handed something that is not a function as its loader.
 *
 * A refusal by name, at the moment of wiring, costs one line and names both the
 * missing method and who was supposed to supply it.
 *
 * ── Why the list is SHORT, and not the host's whole interface ───────────────
 *
 * akao's byte driver has ten methods (`list`, `isDir`, `mkdir`, `move`,
 * `copyFile`… — its own file door needs them). UDB uses FOUR. Demanding ten
 * would make this package impose a law wider than the one it lives by, and the
 * next host would implement six methods to satisfy a contract nobody reads.
 *
 * So each list here is exactly what THIS package calls, and a host's own,
 * larger contract stays the host's (akao keeps its ten in `src/core/FS/driver.js`).
 * Two contracts, two homes, because they really are two different claims.
 */

/**
 * Every port of this package: what it is called, what shape it must have, and
 * which capability it serves.
 *
 * `by` says who IMPLEMENTS the port. Today every one of them is the host's,
 * because UDB owns the capabilities whose law it can state alone and asks for
 * the rest by name. A port UDB implements would be declared here too — the
 * table is the seam, not a list of demands.
 *
 * The method lists are exactly what THIS package calls. akao's byte driver has
 * ten methods (`list`, `isDir`, `mkdir`, `move`, `copyFile`… — its own file door
 * needs them) and UDB uses four. Demanding ten would impose a law wider than the
 * one this package lives by, and the next host would implement six methods to
 * satisfy a contract nobody reads. A host's own, larger contract stays the
 * host's (akao keeps its ten in `src/core/FS/driver.js`): two contracts, two
 * homes, because they really are two different claims.
 */
export const PORTS = {
    driver: {
        shape: "object",
        methods: ["readBytes", "writeBytes", "remove", "entries"],
        fields: ["scope"],
        // A host MAY bring its own — akao injects a ten-verb file door it
        // already had — but it no longer MUST: `driver()` answers with this
        // package's own (OPFS in a browser, node:fs on a server), and
        // `checkDriver()` is the behavioural half of this entry, which shape
        // alone cannot state.
        by: "host, or udb's own",
        serves: "bytes in one store of this realm"
    },
    load: { shape: "function", by: "host", serves: "the bytes at a path, through whatever tiers the host has" },
    infohash: { shape: "function", by: "host", serves: "the content address of bytes" },
    hashes: { shape: "function", by: "host", serves: "the address a path was PUBLISHED under" },
    metadata: { shape: "function", by: "host", serves: "whether a path is a sidecar rather than data" },
    // `chainStore()` answers both of these now, over the driver port, and
    // `checkStore()` is the behavioural half that two methods cannot state.
    store: { shape: "object", methods: ["get", "del"], by: "host, or udb's own", serves: "a chain-store for the lives mount" },
    sql: { shape: "function", by: "host", serves: "open the SQL door a collection is kept in" },
    kv: { shape: "function", by: "host, or udb's own", serves: "open the chain-store a collection is kept in" },
    replicas: { shape: "function", by: "host", serves: "where a database of a replicated directory ships to, by id" }
}

/**
 * Which ports each door needs, and where an EITHER/OR is a real one.
 *
 * `collections` is the either/or: the engine is chosen by what the host
 * injected, so exactly one of `sql`/`kv` is enough and neither is a refusal —
 * which used to surface at the first `collectionMount(name)` instead of here.
 */
export const NEEDS = {
    "statics()": { required: ["driver", "load", "infohash", "hashes", "metadata"] },
    // `door` and `as` exist for the MESSAGE only: a caller writes
    // `createDB({ lives: { store } })`, so that is the name the refusal has to
    // use. The registry keys ports by what they ARE (`store`), and a door says
    // how its own caller spells them — otherwise the one home of the seam would
    // have to be named after one door's argument shape.
    "createDB().lives": { required: ["store"], door: "createDB()", as: { store: "lives.store" } },
    "collections()": { oneOf: [["sql", "kv"]] },
    // `realm` is how a door says it cannot exist everywhere. Replication
    // supervises a process, so a browser realm wires nothing for it — and a host
    // that serves both realms must be able to ASK which doors apply to the one it
    // is in. Without it, "this host answers every door" is a question with no
    // true answer in a browser, and a host would have to keep its own list of
    // which doors to skip: the second home this registry exists to prevent.
    // A door with no `realm` belongs to every realm.
    "replica()": { required: ["replicas"], realm: "node" }
}

/** The byte driver, as the statics engine and `walk` use it. */
export const DRIVER = PORTS.driver.methods

/**
 * And what a driver must SAY about itself: which store it reads and writes.
 *
 * A driver is a capability, and until 0.10.0 nothing made it say WHICH store it
 * reads — so a cache in here could not tell two of them apart.
 *
 * The honest size of that: `statics.js` was already safe on its validated
 * branches (a held hash is compared with the deployed one, so another store's
 * body misses; 404 evicts) and its offline branch reads the store before any copy
 * of it. What was left is the LAST line of `$prod` — the offline promise, where
 * the memo answers because the only alternative is `undefined`. A body held from
 * a store nobody is reading any more is akao #705 wearing that promise as a
 * disguise: a suite stages two trees, a fork run points at one site's build, a
 * worker inherits another root through `workerData`.
 *
 * One line, and it is measured: the test named "the offline promise is the last
 * body of THIS store" goes red without the scope in the memo key. (The first
 * draft of this change shipped with a test that passed either way — the bait is
 * why this paragraph says "the last line" and not "the memo".)
 *
 * A string, opaque to this package: `"OPFS"` in a browser, an absolute path on a
 * disk, whatever names ONE store for the host. Two drivers with the same scope
 * claim to be the same store.
 */
export const DRIVER_FIELDS = PORTS.driver.fields

/** A chain-store, as the `lives` mount uses it: a root that chains, plus a wipe. */
export const STORE = PORTS.store.methods

/**
 * Refuse anything missing a method, by name, saying who was to supply it.
 *
 * `what` names the role ("driver", "lives.store") and `who` names the door that
 * needs it, because the caller reading this error is wiring a host, not reading
 * this package.
 */
export function requires(value, methods, what, who, fields = []) {
    if (!value || typeof value !== "object") throw new Error(`UDB: ${who} needs a ${what} object — the host injects it (got ${value === null ? "null" : typeof value})`)
    const missing = methods.filter((method) => typeof value[method] !== "function")
    if (missing.length) throw new Error(`UDB: the ${what} injected into ${who} is missing ${missing.map((method) => `${method}()`).join(", ")} — ${what} needs ${methods.join(", ")}`)
    // A field is checked as strictly as a method, and for the same reason: an
    // empty or absent `scope` would leave the caches inside this package keyed by
    // path alone, which is the silent-wrong answer DRIVER_FIELDS exists for.
    const blank = fields.filter((field) => typeof value[field] !== "string" || !value[field].length)
    if (blank.length) throw new Error(`UDB: the ${what} injected into ${who} must declare ${blank.join(", ")} as a non-empty string — ${blank.includes("scope") ? "a scope names WHICH store this driver reads, and without it a cache here cannot tell two stores apart (akao #705)" : "the contract says so"}`)
    return value
}

/** The same refusal for a plain function, which is how `load` and `infohash` arrive. */
export function requiresFunction(value, what, who) {
    if (typeof value !== "function") throw new Error(`UDB: ${who} needs ${what} to be a function — the host injects it (got ${value === null ? "null" : typeof value})`)
    return value
}

/**
 * Check a whole wiring against the ports the door needs — one call, at wiring.
 *
 * `who` names the door as a caller writes it (`"statics()"`), because the person
 * reading the error is wiring a host, not reading this package. A port absent
 * from `wiring` is refused by NAME along with what it is for, so the fix is the
 * message rather than a stack.
 */
export function conform(who, wiring = {}) {
    const needs = NEEDS[who]
    if (!needs) throw new Error(`UDB: ${who} asked the port registry for its needs and the registry does not know that door — add it to NEEDS in contract.js, which is the one home of the seam`)
    const door = needs.door ?? who
    const label = (name) => needs.as?.[name] ?? name
    for (const name of needs.required ?? []) check(name, wiring[name], door, label(name))
    for (const group of needs.oneOf ?? []) {
        const given = group.filter((name) => wiring[name] !== undefined && wiring[name] !== null)
        if (!given.length) throw new Error(`UDB: ${door} needs one of ${group.map((name) => `${label(name)} (${PORTS[name].serves})`).join(" or ")} — the host injects one, and which one it gives is what decides the engine`)
        for (const name of given) check(name, wiring[name], door, label(name))
    }
    return wiring
}

/** One port, by its declaration. */
function check(name, value, door, label = name) {
    const port = PORTS[name]
    if (!port) throw new Error(`UDB: ${door} asked for a port named "${name}" that contract.js does not declare — the registry is the one home of the seam`)
    if (port.shape === "function") return requiresFunction(value, label, door)
    return requires(value, port.methods, label, door, port.fields ?? [])
}

export default { PORTS, NEEDS, conform, DRIVER, DRIVER_FIELDS, STORE, requires, requiresFunction }
