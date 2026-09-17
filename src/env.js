/**
 * WHICH REALM is this — the one home of that answer, for this package and for
 * any host that would otherwise write it again.
 *
 * NODE means a Node.js process; BROWSER covers windows AND workers (both carry
 * `location.origin`, neither carries `process`). Nothing else is claimed: a
 * host's own realm facts — is this Windows, is this a dev server — are the
 * host's, and it composes them around this rather than restating these two.
 *
 * ── Why it is EXPORTED, when the reason it exists was the opposite ────────
 *
 * This file used to say "UDB's own, so the package imports nothing from its
 * host", and that was the right reason before the seam existed: a package must
 * not reach into a host to learn what realm it is in. It says nothing about the
 * other direction. Measured 2026-09-17 against akao: its
 * `src/core/Utils/environment.js` held these same three lines, byte for byte —
 * same function name, same two conditions, identical md5 — because a host that
 * needs the answer and finds no export has exactly one option left.
 *
 * One law, two homes, both writable, no arbiter: docs/DRIFT.md §7's expensive
 * configuration, sitting precisely on the boundary between the two repositories.
 * The cure is the cheapest one there is — the package that can state the law
 * without naming anybody states it, and says so out loud in its exports.
 *
 * `detectEnvironment(scope)` takes the scope for the same reason it always did:
 * a caller testing the other realm hands it a fake global, which is the only way
 * either branch is measurable at all.
 */
export function detectEnvironment(scope = globalThis) {
    const NODE = !!scope?.process?.versions?.node
    const BROWSER = !NODE && !!scope?.location?.origin
    return { NODE, BROWSER }
}

const { NODE, BROWSER } = detectEnvironment()

export { NODE, BROWSER }
