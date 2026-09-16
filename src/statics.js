/**
 * The statics engine — ONE at-rest copy, content-addressed.
 *
 * The bytes ARE the store: OPFS in a browser, the build directory on a node
 * — the same bytes whose BEP3 infohash the host publishes (and, for hosts
 * that seed, the torrent identity). A cached body validates ITSELF:
 * recompute its infohash and compare with the deployed hash.
 *
 * Tiers: RAM memo (hash-confirmed) → at-rest bytes (self-validating) → the
 * host's loader (which writes the at-rest bytes as it lands).
 *
 * ── The memo answers a read ONLY when a deployed hash confirms it ────────
 *
 * That is the invariant, and it is why no cached body can lie about a body
 * it does not describe. It reads like a restatement of the tier order; it is
 * not, because the order alone does not give it. A memo entry records what
 * some past moment proved about some store, and the engine holds nothing
 * saying either is still the one being read. Only a hash asked NOW says
 * that, so a branch holding no such hash must read the store, not the copy.
 *
 * The claim used to stand here as true "by construction", and it was not:
 * the offline branch — the one branch with no hash to compare — read the
 * memo first. akao #705 is the bill, measured 2026-09-09. The branch itself
 * carries what was read and why the other two never showed it.
 *
 * Everything environment-specific is INJECTED:
 *   load(path, {fresh, quiet}) — the host's tiered loader (HTTP/disk/P2P)
 *   driver                     — readBytes/writeBytes/remove/entries
 *   infohash(bytes, name)      — → { v1 } content address, the HOST's scheme: this
 *                                 engine computes none and prescribes none, it only
 *                                 compares what it gets with what the origin said
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
import { DRIVER, DRIVER_FIELDS, requires, requiresFunction } from "./contract.js"

export function statics({ load, driver, infohash, hashes, metadata, browser, dev }) {
    // Checked HERE, not at the first read: a driver missing one method used to
    // surface as `driver.entries is not a function` from inside a load, with the
    // cause in the host's wiring and the stack in this package (see contract.js).
    requires(driver, DRIVER, "driver", "statics()", DRIVER_FIELDS)
    requiresFunction(load, "load", "statics()")
    requiresFunction(infohash, "infohash", "statics()")
    requiresFunction(hashes, "hashes", "statics()")
    requiresFunction(metadata, "metadata", "statics()")
    // Refused loudly rather than defaulted: a default would be this engine
    // guessing one host's spelling again, and the guess would be invisible —
    // every read would just quietly stop validating.
    if (typeof hashes !== "function") throw new Error("statics: cần hàm hashes(path) — engine không tự đặt ra địa chỉ của hash đã deploy")
    if (typeof metadata !== "function") throw new Error("statics: cần hàm metadata(name) — engine không biết host gọi sidecar của mình là gì")
    // path.join("/") → { hash, data }. A `hash` is the deployed hash this
    // body was confirmed against, and only an entry whose hash equals the one
    // asked for NOW may answer a read.
    //
    // hash === null means "the last body the LOADER handed us, confirmed by
    // nothing". Such an entry answers no read while any tier below can still
    // speak; it exists so a realm holding nothing at rest and reaching no
    // network serves something rather than undefined.
    const memo = new Map()
    const listeners = new Map()

    /**
     * The memo's key, and the STORE is part of it.
     *
     * Narrower than it first looks, and the narrow version is the true one: the
     * two validated branches are safe by construction already (`ok` compares the
     * held hash with the deployed one, so another store's body simply misses; 404
     * evicts), and the offline branch reads the STORE before any copy of it. What
     * is left is the last line of `$prod` — the offline promise, where the memo
     * answers because the alternative is `undefined`. A held body from a store
     * nobody is reading any more is #705 wearing that promise as a disguise.
     *
     * So the key carries the scope and the promise becomes per store: a store with
     * nothing to promise says `undefined`, and the store that does hold a body
     * still gets its own. The test named "the offline promise is the last body of
     * THIS store" pins exactly that, and goes red without this line — measured,
     * because the first version of this change came with a test that passed
     * either way.
     */
    const keyOf = (path) => `${driver.scope}\u0000${path.join("/")}`

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

            // Offline: we cannot know what the origin states, so nothing this
            // branch returns is validated. The ORDER is the whole of the
            // correctness — the STORE answers before any copy of it does.
            //
            // This branch used to read the memo first, and that was the one
            // door left open to the poisoning class the tier above closes.
            // The two branches above are safe by construction and not by
            // care: `ok` compares the held hash against the deployed one, so
            // a body from a different store simply misses; 404 evicts. Here
            // there is no hash to compare with, so a memo-first read hands
            // back a body with NOTHING asserting it still describes the store
            // being read. Measured 2026-09-09 (akao #705): a host that points
            // its driver at a second build tree within one realm — a node
            // suite staging roots, a builder walking site after site — read
            // the first tree's bytes for every path the second tree also has.
            // Not an exotic input: it is what "one engine, one realm, one
            // store" quietly assumed, and no injection states.
            //
            // At-rest bytes cost a read the memo did not, and that is the
            // right price on the degraded path: this is not the steady state,
            // which is the validated fast path above.
            const bytes = await atRest(path)
            // No memo write here on purpose: an unvalidated entry is exactly
            // what this branch stopped trusting, so holding one would buy the
            // next pass nothing — it would read the store again regardless —
            // and would cost the invariant that `hash: null` means "the last
            // thing the LOADER said", nothing else.
            if (bytes) return parse(bytes)

            const data = await load(path, { quiet: true })
            if (data !== undefined) {
                memo.set(key, { hash: null, data })
                notify(path, data) // first sight in this realm counts as a landing
                return data
            }

            // Nothing at rest and nothing the loader can reach. The last body
            // this realm held is all that is left, and serving it is the
            // offline promise — held last, where it can only ever beat
            // `undefined`.
            return memo.get(key)?.data
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
                // The bytes under the walked name, never a memo entry. walk()
                // enumerates through the DRIVER, so every name reached here
                // exists at rest and the memo can only ever shadow it — it can
                // never add a file to the walk. Shadowing is the whole risk: a
                // memo entry proved itself against a hash asked at some past
                // moment, and this walk holds no hash to re-ask with, so it
                // cannot tell an entry that still describes this store from
                // one describing a store the host has since moved off (#705).
                // The saving given up was small and unreliable anyway — only
                // for files some earlier once() happened to touch.
                const bytes = await atRest(child)
                if (!bytes) return
                const value = parse(bytes)
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
