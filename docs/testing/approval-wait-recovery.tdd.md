# Approval wait recovery, retention, and notifications

Source: review of ADR-023 implementation on
`mc/adr-023-custom-styles-human-steps`, October 25, 2026.
Journeys were derived from the three review findings:

- A person can answer an approval after interrupted closeout and recovery.
- An unanswered approval survives terminal-record cleanup; answering, marking
  done, or deleting the task releases the retained request.
- Opening an approval notifies its owner and assignee once per question, and
  the notification opens the thread where they can answer.

## RED and GREEN

Checkpoint `a99f8ee4` added the reproducers. Running
`UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_team_approval.py -q`
produced four expected failures: interrupted parking, retention for approve
and request-changes answers, and missing notification. Three existing tests
passed. The new web notification test also failed because its notice was
unrecognized.

Checkpoint `a5b812f4` implemented recovery replay, an exclusion for requests
referenced by live approval waits, and transactional, deduplicated approval
notifications with English and Chinese inbox text. The same reproducers
passed; the combined approval/notification API and notification unit target
passed 39 tests, and the web notification target passed 19 tests.

## Final checks

| Guarantee | Test | Result |
| --- | --- | --- |
| Interrupted park recovers without dispatching the held step prematurely | `backend/tests/api/test_team_approval.py` | PASS |
| Both approval answers survive cleanup; the superseded request can then expire | `backend/tests/api/test_team_approval.py` | PASS |
| Mark done and deletion release retention protection | `backend/tests/api/test_team_approval.py` | PASS |
| Each new approval notifies once; replay preserves read state | Approval API tests and `backend/tests/unit/test_notifications.py` | PASS |
| Deduplication is scoped by recipient and question | `backend/tests/unit/test_notifications.py` | PASS |
| A parked approval holds no execution reservation and permits deletion | `backend/tests/unit/test_execution_escape.py` | PASS |
| Inbox notification opens the answering thread | `web/tests/notifications.test.ts`, `web/interaction-tests/notificationBell.test.tsx` | PASS |

The final backend target passed 80 tests:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest \
  backend/tests/api/test_team_approval.py \
  backend/tests/api/test_notification_routes.py \
  backend/tests/unit/test_notifications.py \
  backend/tests/unit/test_execution_escape.py \
  backend/tests/unit/test_schema_scalability.py \
  backend/tests/unit/test_layering.py \
  backend/tests/unit/test_module_size.py -q
```

TypeScript compilation (`npx tsc -p packages/tsconfig.json`) passed. All 1,851
web Node tests corresponding to current `web/tests/**/*.test.ts` sources
passed. Matching source files matters: `dist/web/tests/` also contained stale
compiled tests whose source files no longer exist. The notification Bell and
hooks interaction target passed 12 tests.

Backend Ruff and mypy passed (370 source files); `git diff --check` passed.
The cached, offline npm audit reported zero vulnerabilities. Production web
build passed with `npm run build -w web -- --webpack`; Turbopack could not bind
its local worker port in this environment.

## Coverage and limits

A temporary standard-library tracing harness ran 50 approval, notification,
and persistence tests and recorded 51 of 53 changed Python bytecode line
positions (96.2%) across the four changed runtime modules. The two uncovered
positions were continuation lines of a function annotation. This is a
changed-line measurement, not whole-project coverage; no coverage dependency
was added. Browser E2E was not run; HTTP integration and inbox interaction
tests cover the changed behavior.

The broad backend run reported 3,105 passed, 32 skipped, and five failures.
One was a new test using direct task completion where the existing Mark done
decision is required; that test was corrected and passed in the final
80-test run. The other four failures reproduced against `main`: two tests
affected by local environment files and two installer tests denied access to
`/dev/tty`.

The final full React run passed 617 of 618 tests; the untouched roster keyboard
test timed out, but passed when rerun with the other timing failure from the
initial run. The broad Node package run stalled in unchanged daemon tests and
was stopped; the current web Node target completed successfully separately.
