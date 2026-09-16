/**
 * What UDB needs from the things a host injects — stated, and checked AT WIRING.
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

/** The byte driver, as the statics engine and `walk` use it. */
export const DRIVER = ["readBytes", "writeBytes", "remove", "entries"]

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
export const DRIVER_FIELDS = ["scope"]

/** A chain-store, as the `lives` mount uses it: a root that chains, plus a wipe. */
export const STORE = ["get", "del"]

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

export default { DRIVER, DRIVER_FIELDS, STORE, requires, requiresFunction }
