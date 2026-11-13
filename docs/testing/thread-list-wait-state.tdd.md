# Thread list wait-state regression

Journeys derived from the reported screenshot: a task marked done must not
leave its summary-only thread in Needs you with a waiting subline. Genuine
waits must remain actionable, including waits naming another thread.

Cause: summary inflation omits collaboration rounds. Without the active
round's task scope, the wait resolver trusted a historical blocked outcome
instead of the loaded task's current state. The resolver now indexes task
links and uses them while a summary is awaiting detail. Fully loaded turns
retain their existing scope rules.

## Evidence

- RED: `node --test dist/web/tests/threadGroups.test.js` — 9 passed,
  1 failed; the done task's summary incorrectly appeared in `needsYou`.
- GREEN: compiled with `node node_modules/typescript/bin/tsc -p packages/tsconfig.json`.
  `node --test dist/web/tests/*.test.js` — 2,108 passed.
- Components: `npm run test:react -w web -- --configLoader native --run interaction-tests/threadRowStatus.test.tsx interaction-tests/statusConsistency.test.tsx`
  — 38 passed, including the summary-to-group-to-row regression.
- Full components: `npm run test:react -w web -- --configLoader native`
  — 175 files, 1,157 tests passed. Native config loading avoids writing
  Vite's temporary config into the shared, read-only dependency directory.
- Types: `node node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit --incremental false` — passed.
- Coverage: `node --test --experimental-test-coverage --test-coverage-include='dist/web/src/lib/awaitingInput.js' dist/web/tests/awaitingInput.test.js dist/web/tests/threadWaitIndex.test.js dist/web/tests/threadGroups.test.js`
  — passed; resolver lines/functions 100%, branches 92.47%.

| Guarantee | Test |
| --- | --- |
| Done task summaries stay out of Needs you | `threadGroups.test.ts` |
| Review, running, and cancelled tasks suppress historical blocked outcomes | `threadWaitIndex.test.ts` |
| Named and legacy waits remain visible in the appropriate thread | `threadWaitIndex.test.ts` |
| Active-round scope takes precedence over other links | `threadWaitIndex.test.ts` |
| Done icon and row subline agree with the partition | `threadRowStatus.test.tsx` |
| Fully loaded standalone turns retain their own questions | existing `awaitingInput.test.ts` |

No deployed data was accessed; this reproduces the screenshot's state from
the real summary merge path using local fixtures.

## Python CI extension race

The initial push's Python job failed with one failure and one setup error:
parallel migrations raced to create the database-wide `pgcrypto` extension
inside disposable schemas (`pg_extension_name_index` unique violation).
CI now provisions it in `public` before starting pytest workers, so schema
teardown cannot remove it and workers only observe the existing extension.

- A disposable PostgreSQL reproducer running the migration's extension DDL
  on four concurrent connections failed on three connections before setup.
  After executing the new workflow step, all four passed.
- `pytest tests/unit/test_background_worker_postgres.py tests/unit/test_automation_discovery_migration.py tests/unit/test_schema_drift.py -q -n 4`
  against the disposable PostgreSQL cluster: **26 passed in 97.54s**.
- Dependency audit: zero vulnerabilities. No migration files were changed.
