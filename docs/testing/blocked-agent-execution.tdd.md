# Blocked agent execution — TDD evidence

## Intent and ownership

Derived from the review of “Blocked: Execution needs attention”; no plan file
was supplied. A task should show the actionable dispatch failure, preserve
already-admitted work, and enter In progress only after daemon execution starts.

The changes are confined to Python task dispatch, retry bookkeeping, and the
scheduler. The board already renders `blockerReason`. No protocol, schema,
authentication, daemon execution, or frontend cache changes are required.

## RED and GREEN

The initial regression command was:

```sh
PYTHONPATH=backend /Users/feihe/Workspace/Relay/backend/.venv/bin/python -m pytest backend/tests/unit/test_blocked_execution.py -q --tb=short
```

All 12 initial cases failed for the intended reasons: generic blocker text,
scheduler mutation of admitted work, or premature `running` status. RED
checkpoint: `50fd7718`.

The same cases plus the scheduler suite passed after the fix: 45 passed.
GREEN checkpoint: `b63a0573`. Six existing scheduler assertions were updated
to expect `assigned` before execution instead of encoding premature `running`.

Additional missing-team and missing-project cases bring the regression file to
20 passing cases. Each guarantee is tested against both file-backed and
database-backed task stores:

| Guarantee | Test | Result |
| --- | --- | --- |
| Manual and scheduled agent failures persist their specific blocker reason | `test_disabled_agent_records_actionable_blocker` | PASS |
| Manual and scheduled team/project failures persist their specific blocker reason | `test_missing_assignment_records_actionable_blocker` | PASS |
| Exhausted retries preserve the failure code and last error in the blocker | `test_retry_exhaustion_records_actionable_blocker` | PASS |
| Active claims and admitted run requests remain untouched when an agent becomes disabled | `test_scheduler_leaves_admitted_work_untouched` | PASS |
| Queued work is not redispatched and moves to running only on `run.executing` | `test_scheduler_waits_for_daemon_execution_and_does_not_redispatch` | PASS |

## Verification and limits

- Production web and TypeScript builds passed.
- Node tests: 1,525 passed; React tests: 80 passed.
- `npm audit --registry=https://registry.npmjs.org --json`: zero vulnerabilities.
  The configured mirror does not implement the audit endpoint.
- `npm test`: production build, 1,525 Node tests, and 80 React tests passed.
  Python reported 1,613 passed and two failed assertions that still expected
  scheduled tasks to be running immediately after admission (project and backlog
  API tests). Both assertions were changed to expect `assigned`; their targeted
  rerun passed. The full suite was not rerun after those test-only corrections.
- Final verification under coverage: 22 passed (20 regression cases plus the
  two corrected API tests):

  ```sh
  uv run --project backend --with coverage --extra dev python -m coverage run --append --data-file=/tmp/relay-execution.coverage --source=relay.tasks.scheduler,relay.services.task_dispatch,relay.services.dispatch_retry -m pytest backend/tests/unit/test_blocked_execution.py backend/tests/api/test_project_routes.py::test_scheduler_dispatches_assigned_project_task backend/tests/api/test_tasks.py::test_scheduler_dispatches_assigned_backlog_task -q
  ```

- Coverage collected across `backend/tests` and the final targeted rerun:
  dispatch retry 100%, manual dispatch 84%, scheduler 89%; combined 87%
  (660 of 759 statements). Report command:

  ```sh
  uv run --project backend --with coverage --extra dev python -m coverage report --data-file=/tmp/relay-execution.coverage --show-missing
  ```

- `git diff --check` passed. Existing warnings concern Starlette TestClient,
  a PostgreSQL pytest marker under the root test configuration, and SQLite's
  deprecated datetime adapter.

All task mutations still use authoritative events, and execution remains on
the daemon. Existing blocked records are not rewritten or automatically
unblocked; this fix applies to future transitions. The reported live tasks were
not inspected because the local API requires authentication. No browser E2E
test was added: the changed behavior is exercised through real dispatch,
persistence, scheduler, and daemon-event handling without launching agent CLIs.
