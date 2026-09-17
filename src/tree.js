import { walk } from "./walk.js"

/**
 * TREE operations over the driver port — the family `walk` already belonged to.
 *
 * Every verb here is written once against `driver.entries` / `isDir` / `mkdir` /
 * `copyFile` / `exists`, which this package already ships in both realms. What
 * they have in common with `walk` is the argument: the driver is a PARAMETER, so
 * this package owns the traversal and the host owns the filesystem.
 *
 * Why they arrive now: this package shipped ten driver verbs and a conformance
 * kit for the six beyond its own four, and then left every host to hand-roll the
 * three operations that need more than one verb at a time. Measured in akao
 * (2026-09-17): 47 lines doing exactly this, over the same driver, in three files
 * — and `walk` had already moved here for the same reason a year of hand-rolled
 * recursions is one drift waiting to happen.
 *
 * A missing directory is silence, not an error, in every verb below: asking what
 * is in a tree is a statement about what IS there. The one exception is `find`,
 * whose whole question is "which of these exists" and which therefore has to say
 * when the answer is none.
 */

/**
 * Copy a subtree: files through `copyFile`, directories created on the way down.
 *
 * `skip(path)` is asked BEFORE anything is read, so a caller can exclude a
 * subtree without this function opening it — the difference between "do not copy
 * node_modules" costing nothing and costing a full walk.
 *
 * The result COUNTS rather than answering a bare boolean, because a skipped copy
 * and a completed copy are different facts and a caller that cannot tell them
 * apart will report one as the other. A failure is neither: it throws.
 *
 * ── Why the failure names the LEAF ──────────────────────────────────────────
 *
 * A recursive copy that reports the root of the walk tells a reader which command
 * was run, which they already knew, and hides the one thing they need — WHICH file
 * could not be written. So the leaf wraps its own failure, once, and every level
 * above rethrows it untouched. akao measured the cost of the other way: a build log
 * naming the root of a vendor tree, for a package that had moved one file inside it.
 */
export async function copyTree(driver, from, to, { skip } = {}) {
    if (skip?.(from)) return { copied: 0, skipped: 1 }
    let copied = 0
    let skipped = 0
    if (await driver.isDir(from)) {
        await atLeaf(to, () => driver.mkdir(to))
        for (const { name } of await driver.entries(from)) {
            const result = await copyTree(driver, [...from, name], [...to, name], { skip })
            copied += result.copied
            skipped += result.skipped
        }
        return { copied, skipped }
    }
    await atLeaf(from, () => driver.copyFile(from, to), to)
    return { copied: 1, skipped: 0 }
}

/** One wrap, at the level that actually failed; the marker is how a re-wrap is seen. */
const MARK = "[FS]"
async function atLeaf(path, body, also) {
    try {
        return await body()
    } catch (error) {
        const message = String(error?.message ?? error)
        if (message.includes(MARK)) throw error
        const where = also ? `${path.join("/")} → ${also.join("/")}` : path.join("/")
        throw new Error(`${MARK} copy failed at ${where}: ${message}`, { cause: error })
    }
}

/**
 * Every path under `at` whose RELATIVE path matches — the filtered walk.
 *
 * Relative, not absolute, and that is the whole reason this is not two lines at a
 * call site: a pattern written against the relative path keeps meaning the same
 * thing when the root moves, and a caller matching absolute paths has quietly
 * pinned its regex to one machine's directory layout.
 */
export async function matches(driver, at, pattern) {
    const found = []
    await walk(driver, at, (path) => {
        const relative = path.slice(at.length).join("/")
        if (pattern.test(relative)) found.push(relative)
    })
    return found
}

/**
 * The first of these paths that exists — for a thing with more than one home.
 *
 * Answers `undefined` rather than throwing when none of them does: "which of
 * these is here" is a question, and a caller that has a fallback should not need
 * a try/catch to use it. A caller that has no fallback refuses by its own name,
 * which reads better than this function guessing what the absence meant.
 */
export async function find(driver, paths) {
    for (const path of paths) if (await driver.exists(path)) return path
    return undefined
}

export { walk }
