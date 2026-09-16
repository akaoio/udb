/**
 * How many statements a piece of SQL contains — asked because the platform
 * answers this question WRONG, silently.
 *
 * Measured on Node v24.21 (`node:sqlite`):
 *
 *     db.prepare("CREATE TABLE a(x); CREATE TABLE b(y)").all()
 *     → sqlite_master holds ["a"]        ← the second statement never ran
 *
 * No error, no warning. `prepare` compiles the FIRST statement and hands back
 * the tail unread, so a multi-statement string with parameters loses everything
 * after the first `;`. `exec` runs them all but cannot return rows or take
 * parameters, so neither door is right for both cases and the engine has to
 * know which case it is looking at.
 *
 * This is the whole reason this file exists: turning a silent loss into a
 * refusal by name is worth twenty lines, and the alternative — "remember not to
 * pass two statements with parameters" — is a rule held by memory.
 *
 * It counts `;` that TERMINATE a statement, skipping the four places a `;` can
 * hide without meaning anything: single quotes, double quotes, `--` to the end
 * of the line, and `/* *\/` blocks. SQLite has no dollar-quoting and no nested
 * block comments, so there is no fifth place.
 */

/** The number of statements in `sql` — 0 for whitespace or comments alone. */
export function statements(sql) {
    const text = String(sql ?? "")
    let count = 0
    let pending = false // characters seen since the last `;` that are not blank
    for (let at = 0; at < text.length; at++) {
        const char = text[at]
        if (char === "'" || char === '"') {
            // A quoted literal ends at the matching quote; a doubled quote inside
            // it is an escaped quote, not the end.
            const quote = char
            at++
            while (at < text.length) {
                if (text[at] === quote) {
                    if (text[at + 1] === quote) at++
                    else break
                }
                at++
            }
            pending = true
            continue
        }
        if (char === "-" && text[at + 1] === "-") {
            while (at < text.length && text[at] !== "\n") at++
            continue
        }
        if (char === "/" && text[at + 1] === "*") {
            at += 2
            while (at < text.length && !(text[at] === "*" && text[at + 1] === "/")) at++
            at++
            continue
        }
        if (char === ";") {
            if (pending) count++
            pending = false
            continue
        }
        if (!/\s/.test(char)) pending = true
    }
    // A trailing statement with no `;` after it still counts.
    return pending ? count + 1 : count
}

/** True when `sql` holds more than one statement — the case `prepare` loses. */
export const multiple = (sql) => statements(sql) > 1

export default statements
