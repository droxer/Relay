# Manual retry after dispatch failure

## Intent

The user requested removal of automatic retries after one routine occurrence
created thousands of failed conversations. Failed dispatches now block on the
first attempt and retain the reason. Retrying requires explicit user action.
Initial dispatch and future scheduled routine occurrences remain enabled.

## Changes

- Shared `services/dispatch_failure.py` replaces retry/backoff policy for manual
  and scheduled dispatch. State changes still use task-store events.
- Known rejections release their dispatch claim. Ambiguous outcomes retain the
  claim for reconciliation, but block the task so lease expiry cannot cause an
  automatic retry. Admitted executions remain protected by the existing result
  fence.
- Scheduler rejects historical retry state and queued WIP/ambiguous failures
  without dispatching them. It rechecks the task under its write scope to avoid
  overwriting changed ownership or outcomes.
- Removed the scheduler failure-budget/jitter settings and
  `RELAY_TASK_DISPATCH_MAX_FAILURES` consumption. Historical retry events remain
  readable; no database migration is needed.
- The duplicate-producing task was blocked through the task store in the local
  running environment. Global policy takes effect after backend code reload.

## Verification

RED checkpoint: `b5f4d46c`. Twelve new regressions failed under the old policy,
covering local/database stores, manual/scheduled dispatch, and WIP, capacity,
and ambiguous failures.

| Guarantee | Test | Result |
| --- | --- | --- |
| First failure blocks without a retry deadline | `test_failed_dispatch_requires_manual_retry` | PASS |
| Scheduler restarts do not retry blocked work | Same test, repeated new schedulers | PASS |
| Explicit retry can start a known-rejected task | Same test after explicit status change | PASS |
| Historical failures are not revived | `test_scheduler_does_not_revive_old_failed_attempts` | PASS |
| WIP rejection does not keep creating conversations | `test_wip_rejection_does_not_fill_conversation_list`, real backend admission | PASS |
| Already admitted work is preserved | Existing ownership/fencing and blocked-execution tests | PASS |

Commands and results:

- `uv run --project backend --extra dev pytest backend/tests/unit/test_blocked_execution.py backend/tests/unit/test_task_dispatch.py backend/tests/unit/test_task_scheduler.py -q`: 80 passed.
- `npm run test:py`: 1,732 passed (527 warnings).
- `npm test`: full build passed; TypeScript tests finished with 1,591 passes and
  one unrelated typography failure (`computer.css: font-weight: 600`). The
  backend and React suites were therefore run separately.
- `npm run test:react -w web`: 143 passed across 25 files.
- `npm audit --registry=https://registry.npmjs.org --audit-level=high`: no vulnerabilities.
- `git diff --check`: passed.

Aggregate coverage was not measured; coverage tooling is not installed in the
backend environment. No external deployment or backend restart was performed.
