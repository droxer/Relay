# Task Kanban lifecycle — verification evidence

The user approved the findings in the backlog lifecycle review. Journeys were
derived from that review; the implemented policies are in
[task-kanban-lifecycle.md](../task-kanban-lifecycle.md).

## Guarantees

| Journey | Evidence | Result |
| --- | --- | --- |
| A task cannot claim execution through a card/status edit | API lifecycle tests; browser Ready → In progress drag calls `/runs`, not PATCH | PASS |
| New work requires human acceptance unless automatic acceptance is explicit | API creation/policy tests; parametrized real daemon completion test for human and automatic policies | PASS |
| Blocking review preserves its stage, reason, owner, and start time | Local/database event tests; browser unblock → accept flow | PASS |
| Started work, review, waiting, blocked tasks and continuations share WIP capacity | Local/database tests; actual daemon admission refusal and retry after acceptance | PASS |
| Simultaneous starts cannot oversubscribe an employee | Four concurrent store instances with a one-task cap on SQLite and PostgreSQL | PASS |
| Reopening cannot bypass WIP; an old prepared start cannot overwrite a new blocker | Four RED reproducers, then passing local/database cases | PASS |
| Existing tasks get event-derived projections without rewriting history | Migration replay and downgrade test; PostgreSQL migration-chain/schema checks | PASS |
| Board default order matches scheduler precedence | Queue comparison test and existing scheduler ordering tests | PASS |
| WIP age and cycle time include review and waiting | Web metric and event-materialization tests | PASS |
| Task-scoped recovery and routines retain acceptance policy | Existing HTTP pipeline, team recovery, routine history, and scheduler tests updated for explicit review | PASS |

## RED evidence

- `94bfe15e`: the initial 10 backend cases failed because flow timestamps, blocker
  preservation, acceptance policy, capacity admission, and guarded transitions
  were missing. The initial duplicate test module filename was corrected before
  capturing valid RED evidence.
- The web flow test produced the intended compile-time RED: the flow helper and
  `startedAt`/`blockerReason` contract fields did not exist.
- `7fc11d82`: four additional local/database cases proved that reopening Done
  bypassed WIP and a prepared start could overwrite a subsequent block.
- PostgreSQL testing exposed a UUID/text COALESCE mismatch not observable on
  SQLite. Scope filtering now uses the authoritative snapshot's text identifiers.

## GREEN evidence

Commands executed from the repository root unless otherwise specified:

- `npm test`: full package/web build, 1,443 Node tests, 38 React interaction tests,
  and 1,316 backend tests passed at that checkpoint. Subsequent web-only messaging
  and wrapping changes were covered by the final `npm run test:ts` run below.
- `npm run test:ts`: final production build, 1,444 Node tests, and all 38 React
  interaction tests passed.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_task_kanban.py backend/tests/unit/test_task_execution_ownership.py backend/tests/unit/test_daemon_registry.py -q`:
  259 passed after the admission and recovery fixes.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_schema_drift.py -k wip_admission -q`:
  1 passed against a real PostgreSQL scratch schema, 3 deselected.
- `npx playwright test -c web/playwright.recovery.config.ts taskKanban.spec.ts`:
  2 browser tests passed. These use API fixtures to test actual board controls;
  backend tests separately exercise real stores and daemon admission.
- `npm run lint:css --workspace web`: passed.
- `git diff --check`: passed before handoff.

Coverage:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with coverage coverage run --branch --source=relay.persistence.task_lifecycle -m pytest backend/tests/unit/test_task_kanban.py backend/tests/unit/test_task_flow_migration.py backend/tests/api/test_task_kanban_routes.py -q
UV_CACHE_DIR=.uv-cache uv run --project backend --with coverage coverage report -m
```

23 tests passed. The new policy module reports **93% combined statement/branch
coverage** (64 statements, 3 missed; 40 branches, 4 partial). This is scoped
coverage, not a claim of whole-repository coverage.

## Rollout and residual risks

- Migration `20260913_0069` is included and tested, but has not been applied to the
  user's operational database. Stop backend writers, migrate the intended
  database, and restart with the matching web build. No remote resource was changed.
- The WIP limit must match across replicas. Admission correctness uses a global
  PostgreSQL transaction lock; no production-scale latency benchmark was performed.
- The SLE begins as an explicitly labeled 8-day/85% estimate until 20 completed
  samples exist. Board metrics exclude deleted tasks and are operational summaries.
- The configured npm mirror does not implement the audit endpoint. Retrying
  `npm audit --registry=https://registry.npmjs.org` reported 13 existing dependency
  vulnerabilities (5 moderate, 7 high, 1 critical). This change does not alter
  dependencies or attempt unrelated package upgrades.
- Existing Starlette/httpx, SQLite datetime, and schema reflection warnings remain.

## PR integration verification

Merged current `origin/main` (`2b580323`) before opening the PR. Preserved its
card layout and dispatch-result ownership guards. Task write scopes acquire the
WIP admission lock before task row locks so nested status bookkeeping follows
the event writer's lock order. PostgreSQL concurrency coverage now exercises
both direct event writes and writes inside task write scopes.

- `npm test`: production build, 1,448 Node tests, 38 React tests, and 1,336
  backend tests passed after integration.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_schema_drift.py -k wip_admission -q`:
  2 passed against PostgreSQL, 3 deselected.
- `npx playwright test -c web/playwright.recovery.config.ts taskKanban.spec.ts`:
  2 passed.
- `npm run lint:css --workspace web` and `git diff --check`: passed.
- `npm audit --registry=https://registry.npmjs.org`: 0 vulnerabilities after
  integrating main's dependency updates; this supersedes the earlier audit result.
