# PostgreSQL task queue TDD evidence

## Source plan

[PostgreSQL task queue implementation plan](../postgres-task-queue-plan.md).
This implementation delivers its first milestone: durable retry state and
queryable retry eligibility. Atomic multi-worker batch claims, routine
uniqueness, and queue UI remain planned follow-up work.

## User journeys

- As an operator, I want a dispatch retry deadline to survive a backend restart
  so a failed task is not retried immediately after restart.
- As an operator, I want deferred work excluded by the database queue query so
  routing does not load work that cannot run yet.
- As an operator, I want successful dispatch to clear stale retry state so a
  later task cycle is eligible immediately.

## RED and GREEN evidence

| Behavior | RED evidence | GREEN evidence | Guarantee |
| --- | --- | --- | --- |
| Event-backed retry state | `pytest backend/tests/unit/test_task_store.py -q` — 2 failures: missing `record_dispatch_retry` | Same command — 33 passed | Local and database task stores replay retry count, deadline, code, and message. |
| Restart-safe scheduler deadline | `pytest backend/tests/unit/test_task_scheduler.py -q` — failure reached routing because persisted deadline was ignored | `pytest backend/tests/unit/test_task_scheduler.py backend/tests/unit/test_task_store.py -q` — 61 passed | A fresh scheduler skips a task whose persisted deadline is in the future. |
| Queryable eligibility | `pytest backend/tests/unit/test_task_store.py -q` — 2 failures: future retry tasks returned by queue list | `pytest backend/tests/unit/test_task_store.py backend/tests/unit/test_task_scheduler.py -q` — 63 passed | Both stores omit future-retry tasks; PostgreSQL uses the projected deadline column. |
| Retry clearing | `pytest backend/tests/unit/test_task_store.py -q` — 2 failures: missing `clear_dispatch_retry` | `pytest backend/tests/unit/test_task_store.py backend/tests/unit/test_task_scheduler.py backend/tests/unit/test_task_dispatch.py -q` — 70 passed | Successful scheduled and manual dispatch clear retry state. |
| Restart-safe failure count | `pytest backend/tests/unit/test_task_scheduler.py -q` — fresh scheduler persisted `failureCount=1` over the stored count | `pytest backend/tests/unit/test_task_store.py backend/tests/unit/test_task_scheduler.py backend/tests/unit/test_task_dispatch.py -q` — 80 passed | The count derives from persisted `dispatchRetry.failureCount`; the in-memory backoff map is gone. |
| Classified vs ambiguous failures | Manual dispatch recorded no retry state; scheduled retries stored `code="dispatch_failed"` and a generic message | Same command — 80 passed | Classified failures persist the real code and a bounded message; ambiguous acceptances keep the claim and consume no budget. |
| Retry policy shared by both paths | `task_dispatch.py` cleared retry state only on success | Same command — 80 passed | `services/dispatch_retry.py` owns the count/backoff/jitter/blocking rules for scheduled and manual dispatch. |
| Clear-event noise | `clear_dispatch_retry` appended an event on every success | Same command — 80 passed | The event is appended only when retry state exists (both stores). |

## Additional verification

- `alembic -c backend/alembic.ini heads` reported `20260908_0066 (head)`.
- `pytest backend/tests/unit/test_task_dispatch.py backend/tests/unit/test_schema_drift.py -q` passed 7 tests. The PostgreSQL-only schema-drift test was not exercised because no live test database was available.
- Focused suites after the review fixes: `test_task_store.py` 41 passed, `test_task_scheduler.py` 32 passed, `test_task_dispatch.py` 7 passed.
- Full backend suite: 1121 passed, 2 pre-existing failures in `tests/unit/test_backend_structure.py` (Dockerfile assertions, failing on the base commit too).
- `git diff --check` passed after the focused backend suite.

## Coverage and known gaps

`pytest --cov=relay --cov-report=term-missing ...` could not run because the
environment does not provide `pytest-cov`; pytest rejected the `--cov` options.
`npm test` could not start TypeScript compilation because this worktree lacks
installed Node dependencies (`tsc: command not found`). Install dependencies
with `npm install`, then run `npm test`. Run PostgreSQL schema-drift and
concurrency tests with `RELAY_TEST_DATABASE_URL` pointing to a live database.

The code is covered by focused unit tests for both local and database task
stores, but no claim-race test is added in this milestone because the existing
single-row claim protocol is unchanged. The next plan phase must add real
PostgreSQL `SKIP LOCKED`, fencing, and routine-deduplication integration tests.

## Checkpoint commits

- `383d8155`: RED reproducer for durable retry state.
- `5d07358a`: RED reproducer for restart-safe scheduler behavior.
- `d4688e36`: RED reproducer for database eligibility filtering.
- `8cf3d313`: RED reproducer for clearing retry state.
- `0638d1c9`: GREEN implementation for persisted task dispatch retry state.
