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

export const Local = { peek, put, del, on }
export default Local
