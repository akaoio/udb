/**
 * GatewayNode — one chain, every mount.
 *
 * A node is nothing but (mount, path). Verbs delegate to the mount's handler
 * table; a verb a mount does not offer throws by NAME, loudly — the grammar
 * never silently no-ops. get() chains; an array key is sugar for chaining
 * each segment, so both spellings land on the same node.
 */
export class GatewayNode {
    constructor(mount, path = []) {
        this.mount = mount
        this.path = path
    }

    get(key) {
        if (Array.isArray(key)) return new GatewayNode(this.mount, [...this.path, ...key])
        return new GatewayNode(this.mount, [...this.path, key])
    }

    $verb(name, args) {
        const handler = this.mount.verbs[name]
        if (!handler) throw new Error(`DB: mount "${this.mount.name}" does not support ${name}()`)
        return handler(this.path, ...args)
    }

    once(...args) {
        return this.$verb("once", args)
    }
    put(...args) {
        return this.$verb("put", args)
    }
    del(...args) {
        return this.$verb("del", args)
    }
    on(...args) {
        return this.$verb("on", args)
    }
    map(...args) {
        return this.$verb("map", args)
    }
    peek(...args) {
        return this.$verb("peek", args)
    }
    find(...args) {
        const promise = this.$verb("find", args)
        // A live query rides the SAME promise: await it for a one-shot,
        // or .on(callback) for that result now and a redelivery after every
        // settled write to the collection (realm-local, like every on()).
        if (this.mount.verbs.watch) promise.on = (callback) => this.$verb("watch", [args[0], promise, callback])
        return promise
    }
}

export default GatewayNode
