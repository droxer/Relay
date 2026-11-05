# deepmerge security patch

This is upstream deepmerge 4.3.1's CommonJS bundle and type declarations,
with its MIT license retained. The root override selects this copy for every
consumer, including the shadcn registry tooling.

[CVE-2026-93753](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
has no patched upstream release as of 2026-11-05. Assigning an own `__proto__`
key from an untrusted target, or from a source merged into a null-prototype
target, changes the returned object's prototype.

The patch writes own data properties using `Object.defineProperty` in both
copy loops. It preserves normal recursive merges, symbol keys, array merges,
and custom merge functions without invoking an inherited prototype setter.

Run `npm run test:security-dependencies` from the repository root. The tests
resolve the installed dependency, so they also check that the override works.
Replace this copy with an upstream release once the advisory has a fix and
the same regressions pass.
