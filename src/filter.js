/**
 * The collection filter — ONE meaning, TWO backends (from akao #116 Phase 2).
 *
 * A filter is DATA (a plain object), so it serializes across realms:
 *
 *   { status: "pending" }                        equality
 *   { amount: { $gt: 1, $lte: 5 } }              ops AND together
 *   { "meta.priority": "high" }                  dot paths
 *   { "&": [f1, f2], "|": [f3, f4] }             combinators, nestable
 *   {}                                           matches everything
 *
 * Ops: $eq $ne $gt $gte $lt $lte $in $nin. Top-level keys all AND together.
 * ("&"/"|" follow the same convention Utils/data.js evaluate() uses — the
 * old #27's "logic()" engine never actually existed.)
 *
 * Two backends, one meaning:
 *   match(doc, filter)  — the JS matcher (node kv engine, future live queries)
 *   compile(filter)     — SQL WHERE over json_extract (browser SQL engine)
 * The FilterConformance suite runs one table of cases through BOTH — if they
 * ever disagree, the build goes red. Known traps handled explicitly:
 *   - json_extract yields NULL for BOTH explicit null and a missing field;
 *     the matcher distinguishes them, so the compiler uses json_type to say
 *     which one it means.
 *   - SQLite stores JSON booleans as 0/1; boolean params are normalized.
 */

const OPS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"])

function valueAt(doc, path) {
    let node = doc
    for (const key of path.split(".")) {
        if (node === null || typeof node !== "object") return undefined
        node = node[key]
    }
    return node
}

function isOpObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 && Object.keys(value).every((k) => OPS.has(k))
}

function leafMatch(actual, op, expected) {
    switch (op) {
        case "$eq":
            return actual === expected
        case "$ne":
            return actual !== expected
        case "$gt":
            return actual !== undefined && actual !== null && actual > expected
        case "$gte":
            return actual !== undefined && actual !== null && actual >= expected
        case "$lt":
            return actual !== undefined && actual !== null && actual < expected
        case "$lte":
            return actual !== undefined && actual !== null && actual <= expected
        case "$in":
            return Array.isArray(expected) && expected.includes(actual)
        case "$nin":
            return Array.isArray(expected) && !expected.includes(actual)
        default:
            throw new Error(`DB filter: unknown operator ${op}`)
    }
}

/** The JS matcher — one doc against one filter. */
export function match(doc, filter = {}) {
    for (const [key, condition] of Object.entries(filter)) {
        if (key === "&") {
            if (!condition.every((sub) => match(doc, sub))) return false
            continue
        }
        if (key === "|") {
            if (!condition.some((sub) => match(doc, sub))) return false
            continue
        }
        const actual = valueAt(doc, key)
        if (isOpObject(condition)) {
            for (const [op, expected] of Object.entries(condition)) if (!leafMatch(actual, op, expected)) return false
        } else if (actual !== condition) return false
    }
    return true
}

/** The SQL compiler — the same filter as a WHERE clause over json_extract. */
export function compile(filter = {}) {
    const params = []
    const where = compileNode(filter, params)
    return { where: where || "1=1", params }
}

function compileNode(filter, params) {
    const clauses = []
    for (const [key, condition] of Object.entries(filter)) {
        if (key === "&") {
            const subs = condition.map((sub) => compileNode(sub, params) || "1=1")
            clauses.push(`(${subs.join(" AND ")})`)
            continue
        }
        if (key === "|") {
            const subs = condition.map((sub) => compileNode(sub, params) || "1=1")
            clauses.push(`(${subs.join(" OR ")})`)
            continue
        }
        const jsonPath = `'$.${key.replaceAll("'", "''")}'`
        const extract = `json_extract(doc, ${jsonPath})`
        if (isOpObject(condition)) {
            for (const [op, expected] of Object.entries(condition)) clauses.push(compileLeaf(extract, jsonPath, op, expected, params))
        } else {
            clauses.push(compileLeaf(extract, jsonPath, "$eq", condition, params))
        }
    }
    return clauses.join(" AND ")
}

// SQLite stores JSON true/false as 1/0 — bind booleans the way the engine
// stores them so equality means what the matcher means.
function bind(params, value) {
    params.push(typeof value === "boolean" ? (value ? 1 : 0) : value)
    return "?"
}

function compileLeaf(extract, jsonPath, op, expected, params) {
    // null vs missing: json_extract is NULL for both. json_type is 'null'
    // for an explicit null and NULL for a missing field — exactly the
    // distinction the matcher makes with === null vs undefined.
    if (expected === null) {
        if (op === "$eq") return `json_type(doc, ${jsonPath}) = 'null'`
        if (op === "$ne") return `(json_type(doc, ${jsonPath}) IS NULL OR json_type(doc, ${jsonPath}) <> 'null')`
        throw new Error(`DB filter: ${op} does not accept null`)
    }
    switch (op) {
        case "$eq":
            return `${extract} = ${bind(params, expected)}`
        case "$ne":
            // NULL <> x is NULL in SQL, but the matcher says a missing field
            // IS "not equal" — treat NULL as passing.
            return `(${extract} IS NULL OR ${extract} <> ${bind(params, expected)})`
        case "$gt":
            return `${extract} > ${bind(params, expected)}`
        case "$gte":
            return `${extract} >= ${bind(params, expected)}`
        case "$lt":
            return `${extract} < ${bind(params, expected)}`
        case "$lte":
            return `${extract} <= ${bind(params, expected)}`
        case "$in": {
            if (!Array.isArray(expected)) throw new Error("DB filter: $in expects an array")
            if (!expected.length) return "1=0"
            return `${extract} IN (${expected.map((v) => bind(params, v)).join(", ")})`
        }
        case "$nin": {
            if (!Array.isArray(expected)) throw new Error("DB filter: $nin expects an array")
            if (!expected.length) return "1=1"
            return `(${extract} IS NULL OR ${extract} NOT IN (${expected.map((v) => bind(params, v)).join(", ")}))`
        }
        default:
            throw new Error(`DB filter: unknown operator ${op}`)
    }
}

export default { match, compile }
