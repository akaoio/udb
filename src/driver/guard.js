import { DRIVER_FIELDS } from "../contract.js"

/**
 * A driver WRAPPED so a malformed path is refused at the CALL SITE.
 *
 * ── Why a wrapper, when `pathOf` already refuses ───────────────────────────
 *
 * `pathOf` refuses from INSIDE a driver, which is right and not enough: by then the
 * stack points into this package and the caller that built the bad path is two
 * frames up, on a line the message cannot name. And the drivers this package ships
 * are not the only ones — a host that injects its own gets no refusal at all until
 * the platform underneath produces something obscure.
 *
 * The host this arrived from paid for both halves (akao #355, measured over years):
 * a NESTED array reached a path join, `Array.prototype.toString` turned the segment
 * into `"build,localhost"`, and the answers stayed reasonable in isolation —
 * `dir([root])` answered `[]` for a directory holding 4 987 files, `remove([root,
 * "x"])` answered `true` for a file that was still there. Together, its build's
 * clean step cleaned nothing for years and printed success every time.
 *
 * `null` and `undefined` are refused for the same reason and it is worth stating
 * separately: a join that filters falsy values makes a missing segment silently
 * address the PARENT directory. Same class, different shape, and the quieter one.
 *
 * ── The ten verbs, and why the shape check is here ─────────────────────────
 *
 * A driver missing one of the ten fails at the first call that needs it, inside a
 * walk, with a TypeError naming a property. Checked here it fails at wiring, by
 * name. That is the same argument `conform()` makes for ports, applied one level in:
 * this is a wiring mistake, discovered once, and it must stop the program.
 *
 * ── `segment` is the host's, and the reason is a paid one ──────────────────
 *
 * This package's own law is that a segment is a STRING: a driver that guessed would
 * turn an object into the directory `"[object Object]"`. A host whose own law is
 * wider says so here — akao allows a NUMBER, because a chain id is written
 * `["statics", "chains", 1, "configs.json"]` in a dozen of its files — and the
 * coercion happens ONCE, at this boundary, rather than in every door above it.
 *
 * What that host measured when the coercion was missing: `node:path.join` threw a
 * TypeError from inside the driver, the statics engine above caught it as "nothing
 * at rest", and a chain came up with no architecture — `atRest` answering null for a
 * 663-byte file that was plainly there, and nothing in the failure mentioning a
 * number.
 */
const VERBS = ["readBytes", "writeBytes", "remove", "list", "entries", "exists", "isDir", "mkdir", "move", "copyFile"]

/** Which verbs take TWO paths rather than one. */
const SECOND = new Set(["move", "copyFile"])

/** A string path becomes segments once, here, for every verb. */
const split = (path) => (typeof path === "string" ? path.split("/").filter(Boolean) : path)

function refuse(verb, path, position) {
    if (!Array.isArray(path)) throw new TypeError(`[udb/guard] ${verb}: the ${position} path must be an array of segments or a string, got ${path === null ? "null" : typeof path}`)
    for (let index = 0; index < path.length; index++) {
        const segment = path[index]
        if (typeof segment === "string") continue
        const shown = Array.isArray(segment) ? `an array ${JSON.stringify(segment)} — a missing … to spread it?` : segment === null ? "null" : `a ${typeof segment} (${JSON.stringify(segment) ?? String(segment)})`
        throw new TypeError(`[udb/guard] ${verb}: segment ${index} of the ${position} path is ${shown}, not a string. Path: ${JSON.stringify(path)}`)
    }
}

/**
 * @param {object} driver a byte driver with the ten verbs and a `scope`
 * @param {{ segment?: (value: unknown) => unknown }} [wiring] the host's own widening
 *   of what a segment may be — applied before the refusal, so a law wider than this
 *   package's stays true without every door restating it
 */
export function guard(driver, { segment = null } = {}) {
    for (const verb of VERBS) if (typeof driver?.[verb] !== "function") throw new Error(`[udb/guard] the driver is missing "${verb}" — a driver answers all ten verbs (${VERBS.join(", ")}), and a missing one fails inside a walk instead of here`)
    for (const field of DRIVER_FIELDS) {
        // A GETTER is allowed and is the normal case: a store that moves answers this
        // as a question. What is NOT allowed is a property that merely EXISTS — an
        // earlier version asked "is there an own descriptor OR a string", and
        // `{ ...driver, scope: undefined }` satisfied the first half. A field whose
        // value is undefined is exactly the case this refusal is for, so it has to be
        // the thing that trips it.
        const declared = Object.getOwnPropertyDescriptor(driver, field)
        if (declared?.get) continue
        if (typeof driver[field] === "string" && driver[field].length) continue
        throw new Error(`[udb/guard] the driver's "${field}" is ${driver[field] === undefined ? "missing" : `${typeof driver[field]} (${JSON.stringify(driver[field])})`} — it must be a non-empty string or a getter, because it names WHICH store this driver reads and every cache above it keys by that answer`)
    }

    const widen = segment ? (path) => (Array.isArray(path) ? path.map(segment) : path) : (path) => path

    const guarded = {}
    // Forwarded as a GETTER, because a host's scope moves: the store a realm reads is
    // declared after this module loads and may be staged again by a suite. Copying
    // the value here would make this wrapper name the store it was built over rather
    // than the one it reads — the akao #858 defect, one layer down.
    for (const field of DRIVER_FIELDS) Object.defineProperty(guarded, field, { get: () => driver[field], enumerable: true })

    for (const verb of VERBS) {
        const raw = driver[verb]
        guarded[verb] = (...args) => {
            args[0] = widen(split(args[0]))
            refuse(verb, args[0], "first")
            if (SECOND.has(verb)) {
                args[1] = widen(split(args[1]))
                refuse(verb, args[1], "second")
            }
            return raw.apply(driver, args)
        }
    }
    return guarded
}

/**
 * A store that is NOT THERE — every read answers "nothing", every write is refused.
 *
 * The case: a browser with no Origin Private File System (a private window, an
 * embedding that withheld it). `driver()` refuses by name there and says what to DO
 * with the no is the host's — and this is what every host does with it, because the
 * alternative is a dead page. So it ships here rather than being written again in
 * each one: thirteen lines of shape with nothing host-specific in them.
 *
 * A write ANSWERS rather than throwing, and that is the one decision inside: a page
 * running on the network tier is not a page whose every write is an exception. It
 * answers `{ success: false }` so a caller that checks learns the truth, and a
 * caller that does not is not killed by a store that was never there.
 */
export const emptyStore = ({ scope = "OPFS" } = {}) => ({
    scope,
    readBytes: async () => null,
    writeBytes: async () => ({ success: false }),
    remove: async () => {},
    entries: async () => [],
    list: async () => [],
    exists: async () => false,
    isDir: async () => false,
    mkdir: async () => {},
    move: async () => {},
    copyFile: async () => {}
})
