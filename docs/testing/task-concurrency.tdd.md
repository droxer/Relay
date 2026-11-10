# Task concurrency regression evidence

Journeys were derived from the end-to-end concurrency review: capacity waits
must resume automatically, people must see which capacity they await, and
cancellation must free execution capacity only after the agent process exits.

## Regression evidence

| Guarantee | RED | GREEN |
| --- | --- | --- |
| A full durable queue produces a retryable capacity error | `test_daemon_queue_capacity.py` raised an untyped `ValueError` | Typed `capacity_exhausted`; a freed queue slot accepts the request |
| Manual and scheduled starts remain queued at routing, execution admission, and durable admission | Routing left Tasks assigned; queue overflow failed dispatch | All six combinations queue, release claims, and dispatch after capacity frees |
| A refused new admission closes its Thread | Queue overflow left linked Threads running | Refused Threads fail without blocking the queued Task |
| The board distinguishes Computer capacity from user WIP | `taskExceptions.test.ts` returned null; `taskCapacityWait.test.tsx` rendered no explanation | Both wait types render their specific localized explanation |
| The complete application resumes waiting work after cancellation | The real browser test found the routing wait missing from the board | Two processes run concurrently; the third waits; UI cancellation proves process exit and starts the third automatically |

## Reproduce

```bash
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest \
  backend/tests/unit/test_daemon_queue_capacity.py \
  backend/tests/unit/test_task_dispatch.py \
  backend/tests/unit/test_task_scheduler.py -q
npx tsc -p packages/tsconfig.json
node --test dist/web/tests/taskExceptions.test.js
npm run test:react -w web -- taskCapacityWait.test.tsx
npm run test:e2e:concurrency -w web
```

The E2E suite uses a disposable SQLite database, the real Python HTTP API,
the real daemon's registration/poll/event transport, and real supervised
Node child processes in independent Project workspaces. Only the agent CLI
is substituted; there are no mocked browser API routes. The fixture shuts
down the daemon and backend and removes its temporary workspace. CI runs
this suite separately from the existing PostgreSQL reservation tests.

`taskExceptions.js` coverage under its canonical Node test target: 100% lines,
89.47% branches, 100% functions. The production web build, backend Ruff check,
and backend mypy check passed. The full React suite passed 911 tests.

The broader TypeScript run passed 3,078 of 3,080 tests. The two failures in
`agent-models.test.ts` concern existing model discovery expectations; both
also fail in an isolated rerun, and their production module is unchanged.
The sandbox-restricted Python run was stopped after its HTTP/TTY fixture
failures; all 31 tests in those two affected files pass with local networking
and controlling-terminal access available.

Final Python verification was completed in split runs: the complete non-API
suite passed 2,523 tests with 25 PostgreSQL-dependent skips. The interrupted
API file (`test_team_routes.py`) passed all 129 tests on rerun, and the six
remaining API files passed all 53 tests. A separate daemon registry/API,
Project execution, and Task recovery run passed 381 tests. Final focused
queue, dispatch, scheduler, layering, and module-size checks passed 55 tests.
PostgreSQL-dependent checks remain covered by the existing CI database job;
no local PostgreSQL instance was configured for this run.
