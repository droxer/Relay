# Dependency security verification

## RED

The requested guarantee is that the installed and locked npm dependency tree
contains no vulnerabilities reported by the current npm advisory database,
while math, diagrams, images, daemon configuration, and development tooling
continue to work.

On 2026-10-14, these read-only checks failed:

```sh
npm audit --omit=dev --json --registry=https://registry.npmjs.org
npm audit --json --registry=https://registry.npmjs.org
```

Production audit: 10 vulnerabilities (6 low, 1 moderate, 3 high).
Complete audit: 26 vulnerabilities (6 low, 4 moderate, 15 high, 1 critical).
The report includes affected parent packages as well as vulnerable leaves.

Production leaves: DOMPurify, KaTeX, sharp, smol-toml, source-map-js.
Development leaves: MCP SDK, brace-expansion, braces, fast-uri, ip-address,
postcss-selector-parser, proxy-addr.

The audit itself is the executable reproducer; version assertions that mirror
package overrides would not establish the absence of vulnerability findings.
