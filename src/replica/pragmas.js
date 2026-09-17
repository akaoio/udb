/**
 * How a SQLite database must be OPENED when something else also writes to it.
 *
 * ── Why this is not the caller's taste ─────────────────────────────────────
 *
 * A replicator is not a reader. Litestream creates `_litestream_seq` and
 * `_litestream_lock` INSIDE the database and takes the write lock to do it. WAL
 * lets one reader and one writer coexist; it does NOT let two writers — and
 * `node:sqlite` opens with `busy_timeout = 0`, so "wait a moment for your turn"
 * reaches the caller as a thrown `database is locked` instead of as a short wait.
 *
 * Measured 2026-08-31, litestream 0.5.16 replicating one database while one
 * writer inserted into it for 20 s:
 *
 *     busy_timeout = 0     → 3 303 of 57 375 writes threw (5.8 %)
 *     busy_timeout = 5000  → 0 of 54 170 threw, worst single write 79 ms
 *
 * 5 s rather than the 79 ms measured: this is not a performance budget, it is
 * what keeps a momentary lock from becoming an error, so it sits far above the
 * worst observed wait. It stays FINITE on purpose — a real deadlock must still
 * surface as an error rather than hang.
 *
 * ── Why it is its own file ────────────────────────────────────────────────
 *
 * Data, and nothing else: no imports at all, so a host whose door runs in every
 * realm can state the policy without dragging a process supervisor (and the node
 * builtins it needs) into a tree a browser loads. That trap is not theoretical —
 * a static `node:sqlite` import in this package's own SQL door once took a whole
 * page down, and the suite reported only a timeout.
 */

/** How long a write waits for the replicator's lock before it is an error. */
export const BUSY_MS = 5000

/** The pragmas every database under continuous replication is opened with. */
export const REPLICATED_PRAGMAS = ["journal_mode=WAL", `busy_timeout=${BUSY_MS}`]

export default REPLICATED_PRAGMAS
