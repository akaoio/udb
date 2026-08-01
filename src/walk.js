/**
 * THE tree walk: depth-first over driver.entries, visitor(fullPath) for
 * every file. One primitive for every consumer that enumerates what is at
 * rest — two hand-rolled recursions over the same driver is how walks drift
 * apart. The driver is a parameter: udb owns the walk, the host owns the
 * filesystem.
 *
 * A missing or unreadable directory is silence, not an error: walking is a
 * statement about what is there.
 */
export async function walk(driver, path, visitor) {
    let entries
    try {
        entries = await driver.entries(path)
    } catch {
        return
    }
    for (const entry of entries ?? []) {
        const name = entry?.name ?? entry
        if (typeof name !== "string") continue
        const child = [...path, name]
        if (entry?.isDir) await walk(driver, child, visitor)
        else await visitor(child)
    }
}

export default walk
