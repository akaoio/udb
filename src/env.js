// Environment detection — udb's own, so the package imports nothing from its
// host. NODE means a Node.js process; BROWSER covers windows AND workers
// (both carry location.origin, neither carries process).
export function detectEnvironment(scope = globalThis) {
    const NODE = !!scope?.process?.versions?.node
    const BROWSER = !NODE && !!scope?.location?.origin
    return { NODE, BROWSER }
}

const { NODE, BROWSER } = detectEnvironment()

export { NODE, BROWSER }
