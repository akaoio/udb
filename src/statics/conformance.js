import { PORTS, requiresFunction } from "../contract.js"

/**
 * What the statics engine needs `load` to MEAN — the part no signature says.
 *
 * `load` is the one port whose contract was never written anywhere: the engine's
 * header lists it as "the host's tiered loader (HTTP/disk/P2P)", the rest of what
 * it relies on is scattered through three branches and one parenthesis inside a
 * comment. Everything the engine actually assumes is below, and the assumptions
 * are not small:
 *
 *   A MISS IS `undefined`. The engine tests `data === undefined` to decide
 *   whether a path exists at all, three times, on the hot path of every read. A
 *   loader that throws for "not there" turns a normal absence into an exception
 *   thrown out of `once()`, and a loader that answers `null` makes an absent file
 *   look like a file whose content is null — memoized, announced to watchers, and
 *   wrong in a way no hash can catch.
 *
 *   IT ANSWERS THE PARSED DOCUMENT, not bytes. The engine memoizes what this
 *   returns and hands it to callers unchanged.
 *
 *   `{ fresh: true }` MUST BYPASS the host's own caches. The engine asks for it
 *   exactly when it has decided the at-rest copy is stale, and a loader that
 *   answers from that same copy makes the disagreement permanent: every read
 *   re-detects the mismatch and re-heals into the same stale bytes.
 *
 *   `{ quiet: true }` suppresses the host's own noise. Every call the engine
 *   makes passes it, because a miss here is a question, not an incident.
 *
 * ── What this kit CANNOT check, and says so ───────────────────────────────
 *
 * Whether `fresh` really reached an origin needs an origin, and whether the
 * loader writes the at-rest copy as it lands (the engine expects it to, and
 * stays correct if it does not — it simply re-fetches forever) needs a driver
 * and a server. Those belong to a host's own acceptance suite. What is here is
 * every promise that can be measured with nothing but the loader itself, and the
 * first one is the one that breaks reads.
 */
export async function checkLoad(load, { missing = ["udb-conformance-missing.json"] } = {}) {
    requiresFunction(load, "load", "checkLoad()")

    const broken = []
    const check = (ok, promise) => {
        if (!ok) broken.push(promise)
    }

    let answered
    try {
        answered = await load(missing, { quiet: true })
        check(answered === undefined, `a path with nothing at it must answer undefined — this one answered ${JSON.stringify(answered) ?? String(answered)}, and the engine reads anything that is not undefined as a document that exists`)
    } catch (error) {
        check(false, `a path with nothing at it must ANSWER, not throw — the engine asks this question on the hot path of every read, and a throw turns a normal absence into an exception out of once() (${error?.message})`)
    }

    try {
        const fresh = await load(missing, { fresh: true, quiet: true })
        check(fresh === undefined, "the same question with { fresh: true } must answer undefined too — fresh is about which tier answers, not about what a miss looks like")
    } catch (error) {
        check(false, `{ fresh: true } must be accepted — the engine passes it whenever it has ruled the at-rest copy stale (${error?.message})`)
    }

    if (broken.length) throw new Error(`UDB: this loader does not keep ${broken.length} of the promises the statics engine relies on:\n  - ${broken.join("\n  - ")}`)
    return true
}

export { PORTS }
export default checkLoad
