# Automation v2 final review evidence

Source plan: [automation v2](../plans/2026-10-13-automation-v2.md).

## Guarantees

| User journey | Regression coverage | Result |
| --- | --- | --- |
| A broken automation cannot stop another due schedule from running. | `backend/tests/unit/test_automation_clock.py`: failed occurrence creation rolls back that schedule's advance and partial occurrence; the healthy schedule runs. | PASS |
| A broadcast event retries only its failed recipient. | `backend/tests/unit/test_automation_matcher.py`: healthy recipient is not redelivered, retry retains provenance and timestamp, current filters/state/owner are checked again. | PASS |
| A failed outer transaction cannot commit released SQLite savepoints. | `test_automation_clock.py`: outbox finalization failure rolls back the entire tick. | PASS |
| An active new or resumed one-off has a future date. | `backend/tests/api/test_automation_triggers_api.py`: create, PATCH, and resume reject expired one-offs without mutating state; completed active definitions remain editable. | PASS |
| A completed one-off still offers Run now and does not promise a scheduled run. | `web/tests/routine.test.ts`: exhausted schedule-only definitions are On demand; mixed event triggers are Listening. | PASS |
| An assignee cannot lift a Relay pause or erase it through conversion. | `test_automation_triggers_api.py`: active, ordinary pause, and `isRoutine:false` transitions require owner/admin; ordinary pause toggles and definition edits remain available. | PASS |
| A concurrent scheduler pause survives a stale user edit. | `test_automation_triggers_api.py`: PATCH rereads under the automation lock; resume resets the actual current rate-limit pause. | PASS |

## RED and GREEN checkpoints

- `95f147ff`: expired one-off API tests failed in four cases; list state failed
  as Scheduled instead of On demand; assignee activation and ordinary pause
  tests failed as 200 instead of 403.
- `1499921a`: schedule and broadcast isolation tests failed as zero healthy
  firings instead of one.
- `a29b67e8`: conversion bypass failed as 200 instead of 403.
- `8efa6daf`: three stale PATCH cases and a stale resume failed; resume kept
  a fired count of three instead of resetting it.
- `9633bb00`: implementation checkpoint after GREEN and independent review.
  The owning workers ran the full automation API file (57 passed), clock and
  matcher files (83 passed), and the broader automation unit group (175 passed).
  The independent reviewer reran all four race cases successfully.
  The coordinator's final combined run passed all 140 API/clock/matcher tests.

Validation commands used for focused checks:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_automation_triggers_api.py backend/tests/unit/test_automation_clock.py backend/tests/unit/test_automation_matcher.py -q
npx tsc -p packages/tsconfig.json
node --test dist/web/tests/routine.test.js
```

## Repository verification

- `npm run test:py`: 2,642 passed, 17 skipped, three failed. The run began
  before the conversion fix was imported, so its conversion-bypass test
  still failed; the final combined automation run passed it. The other two
  failures were installer controlling-terminal tests, and their full file
  rerun with the required permissions passed all 16 tests.
  A final `pytest --lf -q` with those permissions passed all three failures.
- Package and web TypeScript checks passed.
- `npm run build -w web -- --webpack` passed.
- `npm run test:react -w web`: 70 files, 464 tests passed.
- The full Node suite reported 2,116 passes, three failures, and one skip.
  All failures were local server/process permission errors. Rerunning the
  affected `install.test.js` and `managed-reconcile.test.js` files with the
  required permissions passed all 4 and 39 tests respectively.
- Web lint and `git diff --check` passed.
- The configured npm audit mirror could not resolve. The read-only retry
  against the public npm registry completed and reported 10 existing
  vulnerabilities (6 low, 1 moderate, 3 high), including `sharp` and
  `source-map-js`. Dependencies were not changed in this continuation.
- `npm test` could not finish its default Turbopack build because its CSS
  worker could not bind a local port, including on the permission-enabled
  retry. The Webpack build and split test runs above provide separate evidence.

## Limits

No new migration is required by these fixes. Production rollout still requires
migrations through `20261013_0093` and a single scheduler during v1/v2 cutover.
An outbox finalization failure intentionally rolls back the entire tick to
avoid losing deliveries. Real PostgreSQL concurrency and browser interaction
were not exercised in this continuation. Python coverage tooling is absent;
no numeric coverage claim is made. Existing web coverage configuration measures
other modules, so it is not evidence of these changes' coverage.
