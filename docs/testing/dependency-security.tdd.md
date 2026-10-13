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

## GREEN for production and patched tooling

- Override sharp to `0.35.5`, including its platform binaries/libvips bundles.
  [The advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
  identifies this as the patched release.
- Override all KaTeX consumers to the already-used direct version `0.18.4`;
  Mermaid, rehype-katex, and remark-math no longer retain vulnerable `0.16.47`
  copies. This avoids unrelated major upgrades/downgrades of the rendering stack.
- Refresh compatible releases of DOMPurify (`3.4.17`), smol-toml (`1.9.1`),
  source-map-js (`1.2.2`), MCP SDK (`1.32.1`), brace-expansion (`5.0.12`),
  fast-uri (`3.1.8`), ip-address (`10.7.4`), postcss-selector-parser (`7.1.6`),
  and proxy-addr (`2.0.8`) in the lockfile. Compatible Mermaid, shadcn, and
  Next ESLint tooling releases changed alongside their dependency trees.
- Used `npm audit fix --ignore-scripts --registry=https://registry.npmjs.org`;
  no dependency lifecycle scripts or forced major-version changes ran.

`npm audit --omit=dev --registry=https://registry.npmjs.org`: **0 vulnerabilities**.
The complete audit drops from 26 to 11 entries and contains no critical,
moderate, or low findings. The remaining high entries all trace to the same
development-only `braces` advisory below.

Compatibility smoke checks passed: SVG-to-PNG processing with sharp,
DOMPurify stripping scripts/event handlers, and real Mermaid flowchart and
sequence parsing in a jsdom document. Package TypeScript compilation, web
lint, and the Webpack production build passed.

The full Node suite passed **2,120 tests**, with no failures or skips,
including the markdown/math rendering and daemon configuration tests.
The React suite passed **70 files / 464 tests**. `git diff --check` passed.
No Python runtime dependency or backend source changed in this follow-up;
the backend results from the automation final-review report still apply.

## Remaining upstream tooling advisory

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
affects all published `braces` versions; the advisory lists **no patched
release**. It is brought in by development dependencies through micromatch
and fast-glob (ESLint's Next plugin, stylelint, and shadcn/ts-morph). npm's
proposed forced downgrade of stylelint and the Next ESLint config is not a
compatible remediation and was not applied. These 11 leaf/ancestor findings
remain visible in the full audit; they are not suppressed or presented as
resolved. Production dependencies have no remaining audit findings.
