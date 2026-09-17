#!/usr/bin/env node
/**
 * Print the seam — from the registry, never from a copy.
 *
 * A host's first question is "what do I have to give you", and until #5 the only
 * answers were a paragraph in the README and three argument lists inside the
 * doors. This prints `src/contract.js`, so the answer cannot be stale.
 */
import { PORTS, NEEDS } from "../src/contract.js"

const width = Math.max(...Object.keys(PORTS).map((name) => name.length))
console.log("\nPorts — what a host implements, and what UDB calls on it:\n")
for (const [name, port] of Object.entries(PORTS)) {
    const shape = port.shape === "function" ? "function" : `object { ${port.methods.join(", ")}${port.fields?.length ? `, ${port.fields.join(", ")} (string)` : ""} }`
    console.log(`  ${name.padEnd(width)}  by ${port.by.padEnd(5)}  ${shape}`)
    console.log(`  ${" ".repeat(width)}  ${port.serves}`)
}
console.log("\nDoors — which ports each one needs at wiring:\n")
for (const [door, needs] of Object.entries(NEEDS)) {
    const required = (needs.required ?? []).map((name) => needs.as?.[name] ?? name)
    const either = (needs.oneOf ?? []).map((group) => `one of ${group.join(" / ")}`)
    console.log(`  ${door}${needs.realm ? ` [${needs.realm} only]` : ""}  ${[...required, ...either].join(", ")}`)
}
console.log("")
