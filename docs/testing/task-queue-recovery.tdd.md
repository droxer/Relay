# Task execution queue recovery evidence

Source: the end-to-end execution queue review in this task. Journeys were
derived from its two findings; no separate plan was supplied.

## Journeys and guarantees

| Journey / guarantee | Test | Type |
| --- | --- | --- |
| A backend timeout reaches failure bookkeeping instead of trapping the scheduler in a hot loop. | `test_await_dispatch_propagates_a_completed_backend_timeout` | Unit |
| A genuinely pending dispatch still waits, and a result completing at the wait deadline is returned. | `test_await_dispatch_keeps_waiting_and_reports_a_slow_backend`, `test_await_dispatch_reads_a_result_that_finishes_at_the_wait_deadline` | Unit |
| A timed-out task is blocked while the next healthy task dispatches in the same tick. | `test_scheduler_records_one_failure_and_dispatches_the_next[timeout]` | Database-backed integration |
| Two daemon processes recovering a crashed workspace owner cannot enter the workspace together. | `workspace-lock-recovery.test.ts` | Process integration |
| A crashed mutation claimant cannot stall a replacement daemon. | `workspace-lock-claims.test.ts` | Process integration |
| Cancellation, incomplete writes, dead claims, and observer failure preserve exclusion and release claims. | `workspace-lock-claims.test.ts`, `workspace-run-gate.test.ts` | Unit / filesystem integration |

## RED

Before modifying production code:

- `uv run --project backend --extra dev pytest backend/tests/unit/test_task_scheduler.py -k completed_backend_timeout -n0 -q`
  failed because a completed failed future was read three times instead of
  propagating its original `TimeoutError`.
- `npx tsc -p packages/tsconfig.json && node --test dist/packages/relay-daemon/tests/workspace-lock-recovery.test.js`
  compiled and failed with `second daemon entered the first daemon's workspace`.
  The test pauses both processes after observing the old owner's death, then
  lets the second resume after the first has acquired a new execution lock.

The test checkpoint is `test: reproduce scheduler timeout loop and competing
workspace recovery`; the GREEN checkpoint is `fix: propagate dispatch timeouts
and serialize workspace recovery`.

## GREEN and coverage

- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with pytest-cov pytest backend/tests/unit/test_task_scheduler.py -n0 -q --cov=relay.tasks.scheduler --cov-report=term-missing`:
  **34 passed**, scheduler statement coverage **80%** (261/326 statements).
  The coverage runner is temporary; no project dependency was added.
- `npx tsc -p packages/tsconfig.json`: passed.
- `node --test --experimental-test-coverage --test-coverage-include='dist/packages/relay-daemon/src/workspace-lock-claims.js' --test-coverage-include='dist/packages/relay-daemon/src/workspace-run-gate.js' dist/packages/relay-daemon/tests/workspace-lock-claims.test.js dist/packages/relay-daemon/tests/workspace-lock-recovery.test.js dist/packages/relay-daemon/tests/workspace-run-gate.test.js`:
  **17 passed**; combined coverage **87.76% lines / 81.10% branches**.
  The new claim module has **94.23% line / 92.86% branch coverage**.
- Backend Ruff passed; mypy found no issues in **503 source files**.
- `npm audit --registry=https://registry.npmjs.org --json`: zero vulnerabilities.
- `uvx pip-audit --path backend/.venv/lib/python3.14/site-packages`: no known
  vulnerabilities; the local `relay` package is not published on PyPI and is skipped.

## Scope and operating assumptions

The backend continues to enqueue work for daemons. No protocol, database schema,
task ownership policy, or execution reservation release rule changes.

The mutation ordering uses unique per-process claim files and Lamport's bakery
protocol. Ticket publication uses atomic rename so a partially written ticket
cannot be mistaken for a smaller one. Dead claim filenames are never reused;
reclaiming one cannot delete another process's replacement claim. The existing
execution lock path remains intact and live existing owners are respected.

All daemons sharing a physical workspace must be updated to obtain the recovery
race protection; older daemons do not participate in mutation ordering. The
protocol assumes a coherent local filesystem, as does the existing workspace
lock. PID reuse conservatively retains a claim until the reused process exits.
Empty claim directories remain to avoid racing directory removal and creation.
The process tests ran on macOS; native Windows execution is left to CI.

The initial `npm test` attempts stopped during the unrelated production web
build: Turbopack could not bind its subprocess port (`Operation not permitted`),
including the attempt outside the sandbox. Full-suite and alternate production
build results are recorded in the PR's evidence section after those runs finish.
