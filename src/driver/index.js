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
 * line runs. The realm is decided once, here, by asking what exists rather than
 * by a flag a caller passes — a flag is a claim about the world, and this is the
 * world answering.
 */
export async function driver(options = {}) {
    if (typeof navigator !== "undefined" && navigator?.storage?.getDirectory) {
        const { opfsDriver } = await import("./opfs.js")
        return opfsDriver(options)
    }
    const { nodeDriver } = await import("./node.js")
    return nodeDriver(options)
}

export { checkDriver, checkFileDoor } from "./conformance.js"
export default driver
