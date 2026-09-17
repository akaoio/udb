/**
 * What a path IS, for the drivers this package ships.
 *
 * An array of string segments. Not a string — the doors above split one before it
 * gets here — and not a number, an object or a nested array.
 *
 * ── Why this refuses instead of coercing ──────────────────────────────────
 *
 * `node:path.join` throws a TypeError on a non-string, from inside itself, and
 * the statics engine above catches everything a read throws and reads it as
 * "there is nothing at rest". Measured 2026-09-17 against a real host: its path
 * law allows a NUMBER segment (a chain id, written `["statics", "chains", 1,
 * "configs.json"]` in a dozen places), so a 663-byte file that was plainly there
 * answered `null`, the engine fell through to a loader, and a chain came up
 * missing a field. Nothing in the failure mentioned a number.
 *
 * Coercing would have hidden it just as well: the caller would keep passing
 * numbers and the package would keep guessing what they meant. `String(1)` is
 * obvious; `String({})` is `"[object Object]"`, which is a directory name nobody
 * chose. So the answer is a refusal that NAMES the segment and its position, and
 * a host whose own law allows numbers converts them at its own boundary — which
 * is where that law lives.
 */
export function pathOf(path, where = "this driver") {
    if (!Array.isArray(path)) throw new Error(`[udb/driver] ${where}: a path is an ARRAY of string segments — got ${path === null ? "null" : typeof path}. The doors above split a string before it reaches a driver.`)
    for (let index = 0; index < path.length; index++) {
        if (typeof path[index] === "string") continue
        const segment = path[index]
        const shown = Array.isArray(segment) ? `an array ${JSON.stringify(segment)} — a missing … to spread it?` : segment === null ? "null" : `a ${typeof segment} (${JSON.stringify(segment) ?? String(segment)})`
        throw new Error(`[udb/driver] ${where}: segment ${index} of ${JSON.stringify(path)} is ${shown}, not a string. A host whose own law allows it converts at its boundary — a driver that guessed would turn an object into the directory "[object Object]".`)
    }
    return path
}

export default pathOf
