/**
 * An in-memory stand-in for the three OPFS handle methods `opfsDriver` uses.
 *
 * Not a mock of a browser: a minimal implementation of the same interface, with
 * the two behaviours that matter for the driver's logic — `NotFoundError` when
 * `create` is false and nothing is there, and `NoModificationAllowedError` when
 * a second writable is opened on a file that already has one. The second is the
 * whole reason the driver has a write queue, so a stand-in without it would let
 * that queue be deleted with every test still green.
 */
const notFound = () => Object.assign(new Error("not found"), { name: "NotFoundError" })

export function memoryDirectory(name = "") {
    const children = new Map()
    return {
        kind: "directory",
        name,
        async getDirectoryHandle(child, { create = false } = {}) {
            if (!children.has(child)) {
                if (!create) throw notFound()
                children.set(child, memoryDirectory(child))
            }
            const handle = children.get(child)
            if (handle.kind !== "directory") throw Object.assign(new Error("not a directory"), { name: "TypeMismatchError" })
            return handle
        },
        async getFileHandle(child, { create = false } = {}) {
            if (!children.has(child)) {
                if (!create) throw notFound()
                children.set(child, memoryFile(child))
            }
            const handle = children.get(child)
            if (handle.kind !== "file") throw Object.assign(new Error("not a file"), { name: "TypeMismatchError" })
            return handle
        },
        async removeEntry(child, { recursive = false } = {}) {
            if (!children.has(child)) throw notFound()
            const handle = children.get(child)
            if (handle.kind === "directory" && !recursive && handle.$size()) throw Object.assign(new Error("not empty"), { name: "InvalidModificationError" })
            children.delete(child)
        },
        async *values() {
            for (const handle of children.values()) yield handle
        },
        async *keys() {
            for (const key of children.keys()) yield key
        },
        $size: () => children.size
    }
}

function memoryFile(name) {
    let bytes = new Uint8Array(0)
    let open = false
    return {
        kind: "file",
        name,
        async getFile() {
            return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
        },
        async createWritable() {
            // The real thing refuses a second writable while one is open, and
            // that refusal is why the driver queues writes per path.
            if (open) throw Object.assign(new Error("already open"), { name: "NoModificationAllowedError" })
            open = true
            return {
                async write(chunk) {
                    bytes = new Uint8Array(chunk)
                },
                async close() {
                    open = false
                }
            }
        }
    }
}
