/**
 * What the browser engine needs ON DISK, declared by the package that owns the
 * dependency.
 *
 * A page has no module resolution: the WASM build cannot be reached by a bare
 * specifier, so a host's builder has to copy these three files into its own tree
 * and the worker imports them by path. Which three files, and where they sit
 * inside `@sqlite.org/sqlite-wasm`, is a fact about THAT package — so it is
 * declared here, next to the engine that needs it, rather than typed into every
 * host's builder.
 *
 * akao's builder had the three paths written out by hand until #851; a version
 * of sqlite-wasm that moves a file would have broken the page with the builder
 * still reporting success.
 *
 * `as` is the name the worker imports, and it is deliberately NOT the source
 * name for the first one: `index.mjs` says nothing where it lands.
 */
export const WASM_ASSETS = [
    { from: ["@sqlite.org", "sqlite-wasm", "dist", "index.mjs"], as: "sqlite3.js" },
    { from: ["@sqlite.org", "sqlite-wasm", "dist", "sqlite3.wasm"], as: "sqlite3.wasm" },
    // The OPFS VFS spawns this proxy itself, by name, from the same directory.
    { from: ["@sqlite.org", "sqlite-wasm", "dist", "sqlite3-opfs-async-proxy.js"], as: "sqlite3-opfs-async-proxy.js" }
]

export default WASM_ASSETS
