import { conform } from "./contract.js"

/**
 * THE TIER LADDER below a validated at-rest copy — the body for the `load` port.
 *
 * ── Why this package owns it ───────────────────────────────────────────────
 *
 * `load` was the one port this package stated the LAW of and shipped no body
 * for. `statics/conformance.js` says, without naming any host: a miss ANSWERS
 * `undefined`, the answer is the parsed DOCUMENT rather than bytes,
 * `{ fresh: true }` must bypass the host's own caches, `{ quiet: true }` silences
 * its noise. Every other port with a conformance kit here also has an
 * implementation here — `driver` has two, `store` has `chainStore`, `sql` has
 * three engines. One law with its body in the host's repository is the shape this
 * seam exists to end, and it was hiding in the last place anybody looked: the
 * port whose contract this package wrote first.
 *
 * The order is this package's to state because this package owns the tier ABOVE
 * it. `statics.js` re-hashes the at-rest copy against the hash the origin
 * published and only calls a loader once that copy is missing or stale — so
 * reading the store first HERE hands back exactly the bytes just rejected: an
 * unvalidated cache below a validated one, failing silently, because stale bytes
 * look identical to fresh ones.
 *
 * ── Where the origin comes from, and why it is a PARAMETER ─────────────────
 *
 * `urlOf(path)` answers where this path is published, or nothing when it is not
 * published anywhere. That single answer is what makes the ladder realm-agnostic
 * without guessing: a browser's store is a CACHE of an origin, and a server's
 * store IS the origin. Deciding that by asking the realm would be this package
 * telling a host what its own store means; deciding it by asking `urlOf` lets a
 * Node process that does have an origin use one, and a browser without one skip
 * the tier. Nothing here asks which realm this is.
 *
 * It is also the spelling of a URL, and spellings belong to hosts: this package
 * paid once for owning one — it built the address of a deployed hash by swapping
 * a file's extension for `.hash`, which made one host's naming the engine's law
 * and cost a round trip per read forever (see `statics.js`).
 *
 * `parse(bytes, name)` is the other parameter of the same kind. Which extensions
 * are text, which are YAML or CSV, whether a name with no extension is a
 * document at all — that is a host's vocabulary, and the port already promises
 * the PARSED document, so the parsing is what the host was always supplying.
 * The default here reads JSON and falls back to text, which is what a host with
 * no vocabulary of its own means.
 *
 * `tier(path)` is one more source, after the store: a swarm, a peer, a mirror.
 * Optional, and exactly one, because a ladder with an open-ended list of tiers is
 * a ladder whose order nobody can state.
 *
 * ── Files only ─────────────────────────────────────────────────────────────
 *
 * A directory is not a document. A host that wants "load this directory into an
 * object" is choosing how a child's name becomes a key — extension stripped or
 * not, one level or recursive — and that is vocabulary again, so it stays with
 * the host, above this.
 */
export function loader(wiring = {}) {
    conform("loader()", wiring)
    const { driver, urlOf, parse = parseDefault, tier = null, fetch: fetcher = globalThis.fetch } = wiring

    const say = (quiet, message) => {
        if (!quiet) console.error(message)
    }

    return async function load(path, options = {}) {
        const quiet = options.quiet === true
        const fresh = options.fresh === true
        const name = path.at(-1)
        const url = urlOf(path)

        // ── The origin, when there is one ──────────────────────────────────
        let served = null
        if (url) {
            let status = null
            try {
                const response = await fetcher(url)
                status = response.status
                if (response.ok) served = new Uint8Array(await response.arrayBuffer())
            } catch {
                // The network being down is this tier's expected path, not an
                // incident: the store and `tier` are below. Every destructive
                // call inside this function reports its own failure instead of
                // leaning on this catch.
            }

            if (served) {
                // Write through as it lands, so the validated tier above has
                // something to validate next time. Reported, never fatal: a
                // store that refuses is a slower client, not a broken one.
                await driver.writeBytes(path, served).catch((error) => console.warn(`UDB loader: could not cache ${name} at rest`, error))
                return decode(served, name, parse, quiet, say)
            }

            if (fresh && status === 404) {
                // The origin says this is gone, so the at-rest copy must follow.
                // Without this, a file deleted at the source lives in the store
                // forever and nobody can say why the client keeps reading it.
                await driver.remove(path).catch((error) => console.warn(`UDB loader: could not evict ${name}`, error))
                say(quiet, `UDB loader: ${url} is gone (404)`)
                return undefined
            }

            if (fresh) {
                // FRESH means "not from a copy". Falling through to the store
                // here would answer with the very bytes the tier above rejected,
                // and the disagreement would then be permanent: every read
                // re-detects the mismatch and re-heals into the same stale copy.
                say(quiet, `UDB loader: ${url} could not be reached, and a fresh copy was asked for`)
                return undefined
            }
        }

        // ── The store: the last net, offline ───────────────────────────────
        const held = await driver.readBytes(path)
        if (held) return decode(held, name, parse, quiet, say)

        // ── One more source, if the host has one ───────────────────────────
        if (tier) {
            const bytes = await tier(path)
            if (bytes) return decode(bytes, name, parse, quiet, say)
        }

        say(quiet, `UDB loader: nothing answers for ${path.join("/")}`)
        return undefined
    }
}

/** A parse failure is a MISS, not a crash: a half-written file must not throw out of a read. */
function decode(bytes, name, parse, quiet, say) {
    try {
        const document = parse(bytes, name)
        return document === null ? undefined : document
    } catch (error) {
        say(quiet, `UDB loader: ${name} could not be parsed — ${error?.message}`)
        return undefined
    }
}

/**
 * What a host with no vocabulary of its own means: JSON, or the text itself.
 *
 * Not exported as a law — it is a default, and a host that has extensions of its
 * own (YAML, CSV, binary) passes `parse` instead. Bytes that are not valid UTF-8
 * come back as bytes, because a decoder that replaces them silently would hand a
 * caller a document made of question marks.
 */
function parseDefault(bytes, name) {
    let text
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
        return bytes
    }
    if (name?.endsWith(".json")) return JSON.parse(text)
    return text
}
