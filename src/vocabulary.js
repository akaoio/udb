import { conform } from "./contract.js"
import { parse as parseCSV, stringify as stringifyCSV } from "./csv/index.js"

/**
 * WHAT BYTES SPELL — the `parse`/`stringify` pair the file door asks a host for.
 *
 * ── Why this is here, when the ports exist precisely so it need not be ─────
 *
 * `fs()` takes `parse` and `stringify` as parameters and calls them a VOCABULARY,
 * a host's own. That is still true of the EDGES — a suffix only one host uses, a
 * format only one host ships a parser for — and it was measured false of the middle:
 * the host that adopted this door had 171 lines answering those two ports, and 135
 * of them were a dependency-free CSV codec while the rest was a list of suffixes
 * that are text everywhere (`json yaml csv tsv txt md html js css`). Exactly ONE
 * entry on that list belonged to it.
 *
 * So the middle ships here and the edges stay ports:
 *
 *   extensions   more suffixes this host calls text (a sidecar name, a private
 *                format). The list below is what is text for everybody.
 *   codecs       `{ yaml: { parse, stringify } }` — a format whose PARSER is the
 *                host's problem. YAML is the case that proves this is not laziness:
 *                the package that reads it is fine in either realm, but a PAGE only
 *                has it if the host's build shipped its bytes, and what a host
 *                ships is not this door's business. A format with no codec falls
 *                back to text, which is the honest answer rather than a throw.
 *
 * ── The two laws that are not about formats at all ─────────────────────────
 *
 * A file whose suffix is not text carries BYTES, and comes back as bytes. Guessing
 * text for an unknown suffix is how a PNG becomes a string of question marks.
 *
 * A structured file that will not PARSE answers its own text rather than throwing.
 * Half a file at rest is a fact, and a caller reading configuration during a build
 * is better served by the raw text — which it can print — than by an exception three
 * layers up. The door treats `undefined` as "nothing here", so answering text is
 * also what keeps a broken file distinguishable from an absent one.
 */
const TEXT = ["json", "yaml", "yml", "csv", "tsv", "txt", "md", "html", "js", "css"]

const suffix = (name) =>
    String(name ?? "")
        .match(/\.\w+$/)?.[0]
        ?.slice(1)
        .toLowerCase() || ""

export function vocabulary(wiring = {}) {
    conform("vocabulary()", wiring)
    const { extensions = [], codecs = {} } = wiring
    const text = new Set([...TEXT, ...extensions])

    /** A name with a suffix nobody calls text carries bytes. */
    const isText = (name) => {
        const ext = suffix(name)
        return !ext || text.has(ext)
    }

    return {
        TEXT: [...text],
        isText,

        parse: (bytes, name) => {
            if (!isText(name)) return bytes
            const body = new TextDecoder().decode(bytes).trim()
            const ext = suffix(name)
            try {
                if (ext === "json") return JSON.parse(body)
                if (ext === "csv" || ext === "tsv") return parseCSV(body, { delimiter: ext === "tsv" ? "\t" : "," })
                const codec = codecs[ext]
                if (codec?.parse) return codec.parse(body)
                return body
            } catch {
                // A structured file that will not parse answers its TEXT — see header.
                return body
            }
        },

        stringify: (document, name) => {
            if (document instanceof Uint8Array) return document
            const ext = suffix(name)
            const encode = (value) => new TextEncoder().encode(value)
            // Indented by four, because these files are read and diffed by people and
            // a one-line JSON diff says nothing about which key changed.
            if (ext === "json") return encode(`${JSON.stringify(document, null, 4)}\n`)
            if (ext === "csv" || ext === "tsv") return encode(stringifyCSV(document, { delimiter: ext === "tsv" ? "\t" : "," }))
            const codec = codecs[ext]
            if (codec?.stringify) return encode(codec.stringify(document))
            return encode(typeof document === "string" ? document : JSON.stringify(document, null, 4))
        }
    }
}
