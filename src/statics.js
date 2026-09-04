/**
 * The statics engine — ONE at-rest copy, content-addressed.
 *
 * The bytes ARE the store: OPFS in a browser, the build directory on a node
 * — the same bytes whose BEP3 infohash the host publishes (and, for hosts
 * that seed, the torrent identity). A cached body validates ITSELF:
 * recompute its infohash and compare with the deployed hash. No persistent
 * memo exists to lie about a body it does not describe — the stale-body
 * poisoning class dies by construction.
 *
 * Tiers: RAM memo (per realm, hash-keyed) → at-rest bytes (self-validating)
 * → the host's loader (which writes the at-rest bytes as it lands).
 *
 * Everything environment-specific is INJECTED:
 *   load(path, {fresh, quiet}) — the host's tiered loader (HTTP/disk/P2P)
 *   driver                     — readBytes/writeBytes/remove/entries
 *   infohash(bytes, name)      — → { v1 } content address
 *   hashes(path)               — → { ok, status, hash }: the DEPLOYED hash
 *   metadata(name)             — → true for a file that describes others
 *   browser, dev               — environment flags
 *
 * ── Why `hashes` is injected rather than fetched here ────────────────────
 *
 * This engine used to BUILD the address of the deployed hash itself: swap the
 * data file's extension for `.hash` and fetch that path. That spelling is the
 * host's, not this engine's, and encoding it here made the engine dictate how
 * many round trips a read costs — one probe per file, forever, because a
 * per-file URL cannot be batched.
 *
 * The host now answers "what hash does the origin state for this path", by
 * whatever means it publishes — a sidecar per file, one manifest per root, a
 * header. The three ANSWERS are what this engine actually reasons about, and
 * they stay right here:
 *
 *   { ok: true, status: 200, hash }  — the origin states a hash: validate
 *   { ok: false, status: 404 }       — the origin states NOTHING for this
 *                                      path: it left the build, or it is an
 *                                      unhashed asset. Serve without
 *                                      validation, hold no validated memo.
 *   { ok: false, status: null }      — we cannot know (offline): serve what
 *                                      we hold, still unvalidated.
 *
 * `metadata` exists for the same reason: `map()` used to skip names ending in
 * `.hash`/`.torrent` — one host's vocabulary, hardcoded in the engine, wrong
 * for any host that names its sidecars differently and wrong for that host
 * too the day it renames one.
 *
 * Reactivity is realm-local by design: on() fires when THIS realm lands
 * fresh data at that path — including bytes that arrived at rest from
 * outside the call (another realm's leech, a node deploy). map() walks what
 * is at rest locally — the honest scope of a cache.
 */
import { walk } from "./walk.js"

export function statics({ load, driver, infohash, hashes, metadata, browser, dev }) {
    // Refused loudly rather than defaulted: a default would be this engine
    // guessing one host's spelling again, and the guess would be invisible —
    // every read would just quietly stop validating.
    if (typeof hashes !== "function") throw new Error("statics: cần hàm hashes(path) — engine không tự đặt ra địa chỉ của hash đã deploy")
    if (typeof metadata !== "function") throw new Error("statics: cần hàm metadata(name) — engine không biết host gọi sidecar của mình là gì")
    // path.join("/") → { hash, data }. hash === null means "held but not
    // validated against a deployed hash" (offline serve, unhashed asset) —
    // such an entry never satisfies the fast path, so the next pass
    // revalidates.
    const memo = new Map()
    const listeners = new Map()

    const keyOf = (path) => path.join("/")

    function notify(path, value) {
        const set = listeners.get(keyOf(path))
        if (set) for (const callback of set) callback(value)
    }

    // The parse rules of the validated-bytes path. Every hashed file is
    // .json by the builder's law; anything else never has a .hash and
    // reaches data through the loader, which owns the full extension table.
    function parse(bytes) {
        const text = new TextDecoder().decode(bytes).trim()
        try {
            return JSON.parse(text)
        } catch {
            return text
        }
    }

    // The deployed hash for a data path — WITH transport status, because 404
    // (the file left the build) and offline (we cannot know) demand opposite
    // reactions: serve-unvalidated-and-forget versus serve-what-we-hold.
    //
    // The host answers; this wrapper only refuses to let a throwing or
    // malformed answer look like a verdict. An engine that treated "the
    // resolver crashed" as 404 would quietly retire validation for every
    // file — the failure this whole tier exists to make impossible.
    async function currentHash(path) {
        let answer
        try {
            answer = await hashes(path)
        } catch {
            return { ok: false, status: null, hash: undefined }
        }
        if (!answer || typeof answer !== "object") return { ok: false, status: null, hash: undefined }
        if (answer.ok && typeof answer.hash === "string" && answer.hash) return { ok: true, status: answer.status ?? 200, hash: answer.hash.trim() }
        return { ok: false, status: answer.status ?? null, hash: undefined }
    }

    // At-rest bytes, or null. Never throws, never touches the network.
    async function atRest(path) {
        try {
            const bytes = await driver.readBytes(path)
            return bytes?.length ? bytes : null
        } catch {
            return null
        }
    }

    const Statics = {
        async once(path) {
            const last = path.at(-1) ?? ""
            if (!last.includes(".")) throw new Error("DB: statics holds files — name one (directories answer to map)")

            if (dev) {
                // Dev serves fresh from the dev server, no hash discipline.
                const data = await load(path, { fresh: true, quiet: true })
                if (data === undefined) memo.delete(keyOf(path))
                else {
                    memo.set(keyOf(path), { hash: null, data })
                    notify(path, data)
                }
                return data
            }

            return Statics.$prod(path)
        },

        // The production tiers, callable directly (tests drive them from a
        // dev realm, where once() above would short-circuit first).
        async $prod(path) {
            const last = path.at(-1) ?? ""

            // A `.hash` path used to be answered here as "the current-hash
            // question about the neighbouring `.json`" — the engine spelling
            // out one host's sidecar convention (gone). A host that wants to
            // ask what hash the origin states for a path calls its own
            // resolver; it owns that spelling and this engine does not.

            const key = keyOf(path)
            const { ok, status, hash } = await currentHash(path)

            if (ok) {
                const held = memo.get(key)
                if (held && held.hash === hash) return held.data

                // Self-validation: the at-rest bytes prove themselves against
                // the deployed hash — the proof is IN the data, nothing else
                // to trust.
                const bytes = await atRest(path)
                if (bytes) {
                    const { v1 } = await infohash(bytes, last)
                    if (v1 === hash) {
                        const data = parse(bytes)
                        const changed = held?.hash !== hash
                        memo.set(key, { hash, data })
                        // At-rest bytes can land from OUTSIDE this call —
                        // another realm's leech, a node deploy. A changed hash
                        // means this realm sees new data NOW: subscribers hear
                        // it here, not only on the fresh-fetch branch.
                        if (changed) notify(path, data)
                        return data
                    }
                }

                // Stale or absent: demand FRESH bytes (the loader writes them
                // at rest); if the network died between the two requests,
                // serve the stale tiers WITHOUT a validated memo — the next
                // pass must still see the mismatch.
                let data = await load(path, { fresh: true, quiet: true })
                const gotFresh = data !== undefined
                if (!gotFresh) data = await load(path, { quiet: true })
                if (data !== undefined) {
                    // Even a fresh body is memoized unvalidated: hash and body
                    // are two requests, and a deploy can land between them.
                    // The next once() validates the at-rest bytes
                    // intrinsically and heals.
                    memo.set(key, { hash: null, data })
                    notify(path, data)
                } else memo.delete(key)
                return data
            }

            if (status === 404) {
                // No deployed hash. Either the file left the build — a fresh
                // load sees the body 404 and evicts the at-rest copy — or it
                // is an unhashed asset that simply loads without validation.
                memo.delete(key)
                // The orphan sidecar this branch used to delete does not
                // exist any more: a host that publishes hashes per FILE was
                // the only shape that could leave one behind, and evicting it
                // meant this engine writing the host's spelling (gone). What
                // is at rest that must go is the BODY, and the loader's fresh
                // pass below evicts it on its own 404.
                const data = await load(path, { fresh: true, quiet: true })
                if (data !== undefined) {
                    memo.set(key, { hash: null, data })
                    notify(path, data)
                }
                return data
            }

            // Offline: serve what we hold — cache first, then the at-rest
            // tiers. Unvalidated by definition; memo stays hash-null.
            const held = memo.get(key)
            if (held) return held.data
            const data = await load(path, { quiet: true })
            if (data !== undefined) {
                memo.set(key, { hash: null, data })
                notify(path, data) // first sight in this realm counts as a landing
            }
            return data
        },

        // Realm-local reactivity: initial value with once() semantics, then
        // every fresh landing at this exact path. Returns unsubscribe.
        async on(path, callback) {
            const key = keyOf(path)
            if (!listeners.has(key)) listeners.set(key, new Set())
            // No catch: a non-file path must throw here exactly as once()
            // does — a silent undefined subscription would never fire and
            // never explain.
            const value = await Statics.once(path)
            callback(value)
            listeners.get(key).add(callback)
            return () => {
                const set = listeners.get(key)
                if (!set) return
                set.delete(callback)
                if (!set.size) listeners.delete(key)
            }
        },

        // Walk the at-rest tree under a prefix: callback(value, fullPath) for
        // every DATA file held locally. No network — enumeration is a
        // statement about what the cache holds, never about what the build
        // contains.
        async map(path, callback) {
            let count = 0
            await walk(driver, path, async (child) => {
                const name = child.at(-1)
                // The host says which names describe other files. This used
                // to be a suffix test written here — one host's vocabulary
                // frozen into the engine, and stale the day that host renamed
                // a sidecar, with the only symptom being metadata handed to a
                // caller as if it were data.
                if (metadata(name)) return
                const held = memo.get(keyOf(child))
                let value = held?.data
                if (value === undefined) {
                    const bytes = await atRest(child)
                    if (!bytes) return
                    value = parse(bytes)
                }
                await callback(value, child)
                count++
            })
            return count
        },

        // The cache the engine owns: RAM everywhere; at-rest only in the
        // browser — on node the statics directory IS the build, not a cache.
        async wipe() {
            memo.clear()
            if (browser) await driver.remove(["statics"]).catch(() => {})
        }
    }

    return Statics
}

export default statics
