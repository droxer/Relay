# Machine identity review fixes

Journeys were derived from the reconnect review: a computer must retain its
existing identity when fingerprint metadata is inaccessible, and simultaneous
daemon starts on a cloned host must adopt the same replacement identity.

## RED and GREEN

Before the fix, the compiled machine-id target passed 9 tests and failed the
3 new regressions: metadata read/write failures returned `host_fp-a` instead
of `mch_legacy`, and two child processes returned different regenerated ids.

An additional interleaving test failed after the first implementation: a daemon
read the old id just before another daemon published the new fingerprint, then
incorrectly returned the old id. Reading the fingerprint before the id fixes
this race because writers publish the id first.

The final focused target passed all 53 tests (15 machine identity tests and
38 thread tests). Regenerated ids are derived from the new host fingerprint,
so simultaneous regeneration and retries after metadata write failure converge
on the same id. Replacement files are published with atomic rename. Fingerprint
metadata reads and writes are best effort and cannot discard a persisted id.

| Guarantee | Test | Result |
| --- | --- | --- |
| Legacy identity survives metadata read and write errors | `machine-id.test.ts`: preserves a legacy id when fingerprint operations fail | PASS |
| New and regenerated identities survive fingerprint write failure and restart | `machine-id.test.ts`: keeps a new/regenerated id when saving its fingerprint fails | PASS |
| A replacement published between reads is adopted | `machine-id.test.ts`: adopts the replacement when another daemon regenerates between its file reads | PASS |
| Two processes observing old clone metadata return one persisted identity | `machine-id.test.ts`: concurrent cloned-host starts adopt one persisted id | PASS |
| Local threads follow a reconnected computer | `threads.test.ts`: follows a local computer that reconnected under a new node id | PASS |

Commands:

```sh
npx tsc -p packages/tsconfig.json
node --test --experimental-test-coverage --test-coverage-include='**/src/machine-id.js' dist/packages/relay-core/tests/machine-id.test.js dist/web/tests/threads.test.js
git diff --check
```

Machine identity coverage: 85.23% lines, 86.05% branches, 93.75% functions.
Uncovered cases primarily concern OS-specific host-id probes on other platforms
and filesystem failure paths. Concurrency uses two actual Node processes with a
barrier around the fingerprint read; metadata errors are injected filesystem
permission failures. No installed services or user machine identities changed.
Existing uncommitted changes were preserved; no checkpoint commits were created.

## Broader verification

- `npm test`: blocked during the default Turbopack web build by local port binding
  (`Operation not permitted`), including the approved retry.
- `npm exec -w web -- next build --webpack`: production build and web typecheck passed.
- Compiled TypeScript suites: 2,033 passed, 5 failed, 1 skipped. Three platform
  failures passed on a permitted rerun of installer/supervisor tests (43 passed).
  The remaining failures are in unchanged project UI sources: `designGrid.test.ts`
  rejects a 720px breakpoint and `projectPage.test.ts` expects a different tab order.
- `npm run test:react -w web`: permitted rerun passed all 431 tests across 67 files;
  the initial sandboxed run had one roster interaction timeout.
- `npm run test:py`: 2,334 passed; the unchanged schema-drift test
  `test_schema_review_backfills_derived_columns_and_projections` failed. This
  failure is also documented in `installer-service-shutdown.tdd.md`; no Python
  implementation or backend test files changed in this fix.
- `git diff --check`: passed.
- Pre-commit `npm audit`: the configured mirror was unreachable. Automatic
  approval review blocked retrying against npm's public registry because the
  request sends dependency metadata; no audit result is available.
