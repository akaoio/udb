/**
 * Local — the small-config child of the data family.
 *
 * A synchronous kv for the handful of per-device settings (locale, theme,
 * fiat, referrer, wallet/avatar selection). Synchronous is the CONTRACT, not
 * a shortcut: hosts read these at module-import time — this is why the
 * grammar has peek().
 *
 * Shape: a memo Map over localStorage. The memo gives same-tab change events
 * (localStorage has none) and makes the engine swappable later without any
 * caller noticing; the `storage` event keeps tabs in sync. Values are JSON on
 * write; reads fall back to the raw string for values written before this
 * module existed ("dark", "vi") — the next put self-heals the encoding.
 *
 * No write-on-read: reading a key NEVER mutates storage — read paths that
 * write are how caches poison themselves.
 */
import { BROWSER } from "./env.js"

const memo = new Map()
const callbacks = new Map()

function storage() {
    return globalThis.localStorage ?? null // absent (plain Node): memo-only
}

function decode(raw) {
    if (raw === null || raw === undefined) return undefined
    try {
        return JSON.parse(raw)
    } catch {
        return raw // legacy value written as a raw string
    }
}

function fire(key, value) {
    const set = callbacks.get(key)
    if (set) for (const callback of set) callback(value)
}

/** Synchronous read: memo first, storage on first touch. Never writes. */
export function peek(key) {
    if (memo.has(key)) return memo.get(key)
    const value = decode(storage()?.getItem(key) ?? null)
    memo.set(key, value)
    return value
}

export function put(key, value) {
    memo.set(key, value)
    try {
        storage()?.setItem(key, JSON.stringify(value))
    } catch (error) {
        console.warn(`Local: could not persist "${key}"`, error)
    }
    fire(key, value)
    return value
}

export function del(key) {
    memo.set(key, undefined)
    storage()?.removeItem(key)
    fire(key, undefined)
}

/**
 * Empty the WHOLE store — the verb a host needs when it offers a factory reset.
 *
 * Without it there is no correct way to do that, and the incorrect way is
 * silent: a host calls `localStorage.clear()` itself, past this door, and this
 * memo keeps every value. The `storage` event does not fire in the tab that
 * made the change (it is specified as a cross-document notification), so the
 * memo has no way to learn. Measured 2026-09-17 in akao: its `reset()` cleared
 * storage, logged "All reset tasks have been completed", and `peek("locale")`
 * still answered `"vi"` — the settings survived their own deletion, in RAM.
 *
 * Keys are collected from BOTH sides before anything is removed, because the
 * two disagree on purpose: the memo holds what this process has touched, and
 * storage holds what earlier sessions wrote. A subscriber to a key this process
 * never read is still owed the news.
 *
 * `key(index)` is the only way to enumerate storage, and a host may hand over a
 * partial shim that lacks it (this package assumes only get/set/remove
 * elsewhere). Then the memo and the storage are still both emptied — only the
 * notification for never-read keys is missed, which is the smallest possible
 * loss and better than refusing to reset.
 *
 * It empties localStorage rather than a prefixed subset because this store
 * writes BARE keys (see `put`): the namespace is this store's whole point of
 * contact with the platform, and a host that keeps other keys there has two
 * writers on one namespace already.
 *
 * @returns {number} how many keys were cleared — a host that logs its reset has
 *   something true to log.
 */
export function clear() {
    const keys = new Set(memo.keys())
    const store = storage()
    if (store && typeof store.key === "function") {
        for (let index = 0; index < store.length; index++) {
            const key = store.key(index)
            if (key !== null) keys.add(key)
        }
    }
    memo.clear()
    try {
        store?.clear()
    } catch (error) {
        // Same posture as `put`: a storage that refuses is reported, never fatal.
        console.warn("Local: could not clear storage", error)
    }
    // After the emptying, so a callback that reads back sees the cleared store.
    for (const key of keys) fire(key, undefined)
    return keys.size
}

/** Subscribe to changes of one key — same-tab puts and other-tab storage events. */
export function on(key, callback) {
    if (!callbacks.has(key)) callbacks.set(key, new Set())
    callbacks.get(key).add(callback)
    return () => {
        const set = callbacks.get(key)
        if (!set) return
        set.delete(callback)
        if (set.size === 0) callbacks.delete(key)
    }
}

// Cross-tab: another tab's write lands here as a storage event — refresh the
// memo and notify, so on() means "this key changed anywhere", not "in this tab".
if (BROWSER)
    globalThis.addEventListener?.("storage", (event) => {
        if (event.storageArea !== globalThis.localStorage) return
        if (event.key === null) {
            memo.clear() // localStorage.clear() elsewhere
            return
        }
        const value = decode(event.newValue)
        memo.set(event.key, value)
        fire(event.key, value)
    })

export const Local = { peek, put, del, clear, on }
export default Local
