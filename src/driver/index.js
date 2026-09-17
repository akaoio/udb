import { detectEnvironment } from "../env.js"

/**
 * The byte driver for THIS realm — the door, mirroring `sqlite/index.js`.
 *
 * A host that has no file layer of its own asks here and gets one; a host that
 * has one keeps injecting it, because `driver` is a port and a port is where an
 * implementation may come from either side. What this door removes is the
 * precondition: until it existed, "bring your own byte driver" was the first
 * thing this package asked of anybody.
 *
 * Async, and for the same reason the SQL door is: `node.js` imports node:fs at
 * its top level, and a static import of that takes a browser page down before a
 * line runs.
 *
 * ── Which realm, and THEN which store ──────────────────────────────────────
 *
 * Two questions, asked in that order, and the order is the whole fix. This door
 * used to ask ONE — `supportsOPFS()` — and take the Node driver whenever the
 * answer was no. In Node that is right by accident: there is no OPFS there
 * either way. In a BROWSER with no OPFS it is wrong in the worst way available:
 * the fallback is `./node.js`, whose first line is `import "node:fs/promises"`,
 * so a page in a private window got a module-resolution error naming node:fs —
 * three layers from the cause, in a realm that has no filesystem to resolve.
 * "Is there an OPFS" was standing in for "is this a browser", and a private
 * window is exactly where the two answers part company (`docs` of the host that
 * found this: a level answering two questions).
 *
 * So: the realm decides which backend can exist at all, and only then is the
 * store's presence asked about. A browser without one is REFUSED BY NAME rather
 * than handed something that cannot work — what to DO with that no is the host's
 * (a degraded read tier rather than a dead page), and `supportsOPFS` is exported
 * so a host can ask before it opens anything.
 *
 * `globals` is a parameter for the same reason `detectEnvironment`'s scope is:
 * it is the only way either branch is measurable. It decides the realm only —
 * the drivers themselves reach for the real platform, because that is what they
 * are for.
 */
export async function driver(options = {}, globals = globalThis) {
    const { NODE, BROWSER } = detectEnvironment(globals)
    if (NODE) {
        const { nodeDriver } = await import("./node.js")
        return nodeDriver(options)
    }
    const { supportsOPFS, opfsDriver } = await import("./opfs.js")
    if (supportsOPFS(globals)) return opfsDriver(options)
    throw new Error(
        BROWSER
            ? "UDB driver(): this browser realm has no Origin Private File System, so there is no byte store for this door to open. Ask supportsOPFS() first and decide what a no means for your host — a degraded read tier keeps the app alive where a throw kills the page — or inject your own implementation through the `driver` port."
            : "UDB driver(): this realm is neither Node nor a browser, so neither backend applies. Inject an implementation through the `driver` port — the port exists because a realm this package has never seen is still allowed to have bytes."
    )
}

export { checkDriver, checkFileDoor } from "./conformance.js"
export { supportsOPFS } from "./opfs.js"
export default driver
