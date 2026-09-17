/**
 * One call at a time, per DATABASE — for a SQL door that speaks over a transport.
 *
 * The remote engine (`sqlite/remote.js`) forwards every verb to whatever holds
 * the real database: a worker, a socket, another process. Something has to
 * serialise those calls and notice when an answer never comes, and where that
 * something lives decides how a wedged database behaves.
 *
 * ── Why the queue is per database, measured ────────────────────────────────
 *
 * A host arrived here with one queue per REALM — a single line every database in
 * the process stood in — and paid for it twice: head-of-line blocking (a slow
 * query on one database delayed every other one), and a watchdog that, on one
 * database's timeout, flushed the ENTIRE shared line. One wedged database killed
 * every other database's in-flight work.
 *
 * So: one instance per database, serialise its calls, watchdog each one, and on a
 * timeout reject only THIS queue's pending items. Siblings keep their own lines.
 *
 * ── Why the transport is injected ──────────────────────────────────────────
 *
 * `send(method, params, callback)` and nothing else. The queue never learns what
 * carries its calls, which is what makes the contract above testable with no
 * worker, no socket and no database — and what lets a host put this in front of a
 * transport this package has never heard of.
 */
export class CallQueue {
    constructor({ send, timeouts = {}, defaultTimeout = 10000 } = {}) {
        if (typeof send !== "function") throw new Error("CallQueue needs a send(method, params, callback) transport")
        this.send = send
        this.timeouts = timeouts
        this.defaultTimeout = defaultTimeout
        this.items = []
        this.processing = false
    }

    call(method, params) {
        return new Promise((resolve, reject) => {
            this.items.push({ method, params, resolve, reject })
            this.pump()
        })
    }

    pump() {
        if (this.processing || this.items.length === 0) return
        this.processing = true

        const { method, params, resolve, reject } = this.items.shift()
        let timedOut = false
        const timeout = this.timeouts[method] ?? this.defaultTimeout

        // Watchdog: if the transport never answers (crash, hang), reject this
        // item and everything queued BEHIND IT ON THIS QUEUE — the database is
        // presumed wedged, but sibling databases keep their own lines.
        const watchdog = setTimeout(() => {
            timedOut = true
            this.processing = false
            reject(new Error(`SQL transport unresponsive: ${method}`))
            while (this.items.length > 0) {
                const next = this.items.shift()
                next.reject(new Error("SQL transport unresponsive, flushed this database's queue"))
            }
        }, timeout)

        this.send(method, params, (response, error) => {
            if (timedOut) return // late response after the watchdog fired — ignore
            clearTimeout(watchdog)
            this.processing = false
            if (error) reject(new Error(error?.message || String(error)))
            else resolve(response)
            this.pump()
        })
    }
}

export default CallQueue
