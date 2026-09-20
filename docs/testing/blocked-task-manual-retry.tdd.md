# Explicit retry of blocked tasks

## Problem and behavior

Failed dispatches intentionally stop in `blocked`, but the manual start endpoint
also rejected them with `A blocked task cannot be started.` Routine starts reuse
the active occurrence, so clicking Run repeatedly encountered the same guard.
Task cards and list rows additionally disabled their start action while blocked.

Explicit HTTP starts now opt into reopening the same blocked task/occurrence.
The dispatcher reloads it under the registry admission lock and task write scope,
checks active claims and task/session run requests, then records an `assigned`
status event before normal assignment resolution and admission. Owned work stays
blocked with `task_execution_active`; retries do not create duplicate executions.
The retry option defaults off for internal callers and automatic scheduling.
Cards and rows expose a localized Retry action. No timer or automatic retry was
introduced, and no operator task was started during validation.

## RED/GREEN

- `707cd911`: API regressions reproduce the exact invalid-state error for agent,
  project, and routine assignments, plus the blocked active-execution guard.
- `bef07e9`: interaction regressions show the missing Retry action on cards/rows.
- Focused backend command:
  `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_task_start_recovery.py backend/tests/unit/test_task_dispatch_lifecycle.py backend/tests/unit/test_blocked_execution.py backend/tests/unit/test_task_dispatch.py backend/tests/unit/test_task_scheduler.py -q`
  passed 99 tests.
- `npm run test:react -w web -- blockedTaskRetry.test.tsx`: 2 passed. Rendering
  does not start work; clicking Retry invokes the explicit start callback once.

No database migration, daemon update, or credential change is required. Restart
the backend and refresh/rebuild the web client to apply the change. Aggregate
coverage was not measured.

## Full verification

- `npm test`: production build, 1,610 TypeScript tests, 143 React tests, and
  1,736 Python tests passed (531 backend warnings).
- After adding the card/row Retry UI, `npm run test:ts` rebuilt the final web
  client and passed 1,610 TypeScript tests plus all 145 React tests.
- `git diff --check` passed; npm audit reported zero vulnerabilities.
