# Backlog agent execution stage — TDD evidence

## Source and journey

No source plan was supplied. The journey was derived from the requested behavior:

> As a backlog user, I want a task to remain Ready while execution is queued and
> move to In progress only when the daemon confirms that an agent is executing,
> so the board reflects the real agent stage.

## RED evidence

- `npx tsc -p packages/tsconfig.json && node --test dist/packages/relay-core/tests/task-store.test.js dist/web/tests/taskFlow.test.js`
  executed the new projection tests and failed twice because the actual stage was
  `running` instead of `assigned`.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_task_kanban.py -q`
  executed the same guarantee against both local and database task stores and
  failed twice with `running != assigned`.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_tasks.py -q -k assigned_backlog_waits_for_scheduler`
  proved the dispatch endpoint still changed the task to `running` before a
  `run.executing` event.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_task_execution_stage_migration.py -q`
  failed because the required projection migration did not yet exist.

RED checkpoints: `62c238ff`, `c5345d95`, and `771588d3`.

## GREEN evidence

| # | Guarantee | Test type | Result |
| --- | --- | --- | --- |
| 1 | An execution claim reserves WIP but leaves the task in Ready. | Python and TypeScript unit | PASS |
| 2 | Dispatching a task does not create an agent run or mark it In progress. | API integration | PASS |
| 3 | A lease-validated `run.executing` event creates the agent run and moves the task to In progress. | API integration | PASS |
| 4 | Multi-agent, team, routine, retry, completion, and review paths retain their behavior after the boundary change. | API and registry integration | PASS |
| 5 | Migration `20260916_0074` realigns existing snapshots without changing task events and restores legacy projection semantics on downgrade. | Migration unit and PostgreSQL schema integration | PASS |
| 6 | TypeScript and Python projections agree on Ready versus In progress. | Cross-runtime unit | PASS |

Final validation:

- `npm test`
  - Node: 1,479 passed.
  - React: 67 passed.
  - Python: 1,497 passed.
  - Production Next.js and all TypeScript workspace builds passed.
- `UV_CACHE_DIR=.uv-cache uv run --project backend alembic -c backend/alembic.ini heads`
  returned the single head `20260916_0074`.
- `git diff --check` passed.

## Coverage and known gaps

Focused lifecycle coverage combined the unit and API lifecycle suites:

```text
backend/relay/persistence/task_lifecycle.py  64 statements, 3 missed, 95%
```

The repository has no single configured JavaScript coverage script. The complete
Node, React, and Python suites were run instead. Existing warnings are unchanged:
Starlette's TestClient deprecation, an unregistered PostgreSQL pytest mark, and
SQLAlchemy's Python 3.12 SQLite datetime adapter deprecation.

## Merge evidence

The RED checkpoints above preserve the failing behavior. The GREEN implementation
keeps task events authoritative, keeps agent execution on the daemon, and changes
only when the task projection enters the running stage.
