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

/** A chain-store, as the `lives` mount uses it: a root that chains, plus a wipe. */
export const STORE = ["get", "del"]

/**
 * Refuse anything missing a method, by name, saying who was to supply it.
 *
 * `what` names the role ("driver", "lives.store") and `who` names the door that
 * needs it, because the caller reading this error is wiring a host, not reading
 * this package.
 */
export function requires(value, methods, what, who) {
    if (!value || typeof value !== "object") throw new Error(`UDB: ${who} needs a ${what} object — the host injects it (got ${value === null ? "null" : typeof value})`)
    const missing = methods.filter((method) => typeof value[method] !== "function")
    if (missing.length) throw new Error(`UDB: the ${what} injected into ${who} is missing ${missing.map((method) => `${method}()`).join(", ")} — ${what} needs ${methods.join(", ")}`)
    return value
}

/** The same refusal for a plain function, which is how `load` and `infohash` arrive. */
export function requiresFunction(value, what, who) {
    if (typeof value !== "function") throw new Error(`UDB: ${who} needs ${what} to be a function — the host injects it (got ${value === null ? "null" : typeof value})`)
    return value
}

export default { DRIVER, STORE, requires, requiresFunction }
