import { detectEnvironment } from "./env.js"
import { conform } from "./contract.js"

/**
 * WHICH STORE this realm reads — declared once, changed only by asking.
 *
 * ── Why this package owns it ───────────────────────────────────────────────
 *
 * Every cache in here is keyed by `driver.scope` (`statics.js`), and the reason is
 * that a host's store MOVES: a suite stages a second tree, a worker inherits a
 * root, a build run points at one site's output. So "which store is this realm
 * reading, and has anything read it before the answer was decided" is a question
 * about THIS package's own correctness, and a law it can state without naming any
 * host. It lived in the host because that is where the roots arrive, which is a
 * different thing — the arrival is a parameter; the discipline is not.
 *
 * ── The failure it refuses, and why the refusal is shaped like this ─────────
 *
 * An undeclared realm has to answer something, and the honest answer for a Node
 * process is its working directory. That is right for every plain entry point —
 * a script, a build, a suite in the repo — and WRONG the moment a different root
 * arrives afterwards: whatever was read in that window came from the wrong tree,
 * and nothing said so. The host that found this measured it (akao #869): swapping
 * a synchronous byte driver for an async one reordered one microtask, the first
 * read of a built tree landed in that window, the at-rest copy answered "nothing
 * here" for a file that was plainly there, and the engine fell through to a loader
 * pointed at the same wrong tree. Nothing in the failure named a tree.
 *
 * So `declare(root, { arrived: true })` REFUSES exactly one shape: a verb was
 * CALLED while the default stood, and the root now arriving is a different tree.
 * Three things do NOT count, and each was learned by breaking a working tree
 * rather than by thinking:
 *
 *   computing the default   A process may start at its working directory, build
 *                           nothing, and boot a realm elsewhere. Common in
 *                           gateways.
 *   reading `scope`         "Which store is this" is not "read this store" — and
 *                           this package asks it of every driver at wiring time,
 *                           before any entry point has spoken.
 *   touching a verb         A conformance check reads `typeof driver.readBytes`
 *                           for every verb. Property reads, no calls.
 *
 * ── Why `arrived` is a flag rather than a comparison ───────────────────────
 *
 * A root that ARRIVES is the entry point's — computed from where the program is,
 * or handed down to a worker. A root a caller CHOOSES is staging, on purpose,
 * after legitimate reads, and must never be refused. The host that found this
 * distinguished them by comparing against the global the root arrives in, which
 * works and couples this law to that host's spelling. A flag says the same thing
 * and leaves the spelling where it belongs.
 *
 * ── Why the state is on `globalThis` ──────────────────────────────────────
 *
 * Not laziness, and not ambient state by choice: a host may load this module TWICE
 * in one process — once from its sources and once from a built tree it is serving —
 * and a module-level variable would give each copy its own root, so a suite staging
 * a tree would move only its own half. Measured in a host whose build tree carries
 * its own copy of this package. The key is namespaced for the same reason.
 */
const STATE = "@akaoio/udb:realm"

/** The one place this door's state lives — see the header for why it is here. */
function state() {
    let held = globalThis[STATE]
    if (!held) held = globalThis[STATE] = { root: undefined, byDefault: null, used: false }
    return held
}

/**
 * A door onto "the store this realm reads".
 *
 * `open(root)` builds a store for a root — a parameter, because what a root MEANS
 * is the host's: a directory on a disk, a mount inside an OPFS, a driver that
 * answers empty when the platform has none.
 *
 * `arrived()` answers the root an entry point has ALREADY put wherever this host
 * collects them, or nothing. It is a question rather than a value because the door
 * asks it at FIRST USE: a module that captured the answer at import time would read
 * an empty collection point and then be wrong for the rest of the process. WHERE
 * roots arrive stays the host's — a global, a worker's data, an environment
 * variable — and this door never learns the spelling.
 *
 * `fallback` is the root to answer with when nothing arrived and nobody declared; in
 * a browser both are ignored, because one origin has one OPFS and a root names
 * nothing there.
 */
export function realm(wiring = {}) {
    conform("realm()", wiring)
    const { open, arrived = null, fallback = null } = wiring
    const { NODE, BROWSER } = detectEnvironment()
    const held = new Map()

    const storeFor = (root) => {
        let store = held.get(root)
        if (!store) held.set(root, (store = open(root)))
        return store
    }

    /**
     * The root, resolved at FIRST use and not re-read after.
     *
     * Read-once is the point: nothing consults the arrival site mid-flight, so no
     * cache above can be handed one store's bytes under another store's key.
     */
    const current = () => {
        if (BROWSER) return "OPFS"
        const now = state()
        if (now.root === undefined) {
            // Has a root ALREADY arrived? An entry point may put one where the host
            // collects them and then simply start working — a suite pointing itself at
            // a built tree does exactly that — so the door has to ASK rather than wait
            // to be told. Without this question such a realm answers the fallback and
            // reads the wrong tree, and the failure names no tree at all: measured on
            // the host that adopted this door, where a suite set its root and never
            // called `declare`, and a file plainly present in the built tree came back
            // as "missing from the build".
            const already = arrived?.() || null
            const answer = already ?? fallback ?? (NODE ? process.cwd() : null)
            now.root = answer
            // A root that ARRIVED is not a default: the refusal below watches for a
            // root arriving AFTER the fallback was read, and a realm that started
            // from an arrived root has no such window. Remembering which it was is
            // the whole of that distinction, and it is invisible at the call site.
            now.byDefault = already ? null : answer
            now.used = false
        }
        return now.root
    }

    return {
        /** The ambient store: whatever this realm's root currently is. */
        driver: new Proxy(
            {},
            {
                get(holder, key) {
                    void holder // empty on purpose: every read is forwarded
                    const root = current()
                    const value = storeFor(root)[key]
                    // Counted when a verb is CALLED — never when it is looked at.
                    //
                    // Only FUNCTIONS are wrapped, and that one condition is what makes
                    // reading a FIELD uncountable: `scope` can never mark this realm as
                    // read, and neither can any field a driver grows later. An earlier
                    // draft also said `key !== "scope"` — and a bait proved that clause
                    // dead, because a string was never going to reach the wrapper. A
                    // guard that cannot fire is a guard a reader trusts for the wrong
                    // reason.
                    //
                    // The wrapper exists only while the fallback stands, which is a
                    // handful of calls at boot.
                    const now = state()
                    if (now.byDefault !== null && root === now.byDefault && typeof value === "function")
                        return (...args) => {
                            now.used = true
                            return value(...args)
                        }
                    return value
                }
            }
        ),

        /** A store for ANOTHER root — held, so asking twice is the same object. */
        at: (root) => (BROWSER ? storeFor(current()) : storeFor(root)),

        /** WHICH root this realm reads right now. */
        current,

        /**
         * Declare this realm's root. Answers the root it replaced, so a caller can
         * put it back.
         *
         * `arrived: true` means the root came from the entry point rather than being
         * chosen by a caller — and that is the only case the refusal above can fire
         * on, because staging a tree deliberately, after legitimate reads, is the
         * door working rather than the door being misused.
         */
        declare: (root, { arrived = false } = {}) => {
            const previous = current()
            const now = state()
            if (arrived && now.used && now.byDefault !== null && root && root !== now.byDefault)
                throw new Error(
                    `UDB realm: this realm was read as "${now.byDefault}" before a root was declared, and the root that arrived is "${root}" — so something read a store before this realm said which store it is, and got the fallback instead. Declare the root before the first read (the entry point's FIRST import), rather than reordering the imports that happen to work today.`
                )
            now.root = root || undefined
            now.byDefault = null
            now.used = false
            return previous
        }
    }
}
