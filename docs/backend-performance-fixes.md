# Backend performance fixes

This change addresses the seven findings from the backend performance review.
It preserves full task mutation/list responses, employee access rules, and
authoritative session/task event logs.

## Changes

| Finding | Change | Regression evidence |
| --- | --- | --- |
| Blocking database work on the event loop | Synchronous API handlers run in FastAPI's worker pool. JSON handlers use an asynchronous, size-limited body dependency. Heartbeat and SSE authorization explicitly offload synchronous work. Scheduler transactions run on a worker; asynchronous backend dispatch stays on the application loop. | API thread assertions, scheduler thread and shutdown tests, API suite |
| Task writes replay all history under lock | Apply only new events to the versioned projection; query the latest ownership event through an index. Full mutation responses hydrate histories after the write scope, capped at the returned version. Scheduler bookkeeping uses compact results. | No-replay and no-history-read tests, ownership and store tests |
| Global task admission lock | Acquire an employee-scoped PostgreSQL advisory lock only when acquiring WIP. Count occupied slots in SQL. SQLite retains its writer serialization. | Concurrent same-employee admission tests, independent-employee progress test |
| N+1 full task lists | Filter employee access and limits in SQL, then fetch histories in batches of at most 500 selected task IDs. | Bounded-query test, full-record API tests |
| Artifact listing loads all session events | Filter sessions, expand artifact projections in SQL, rank regenerated files, and apply the result limit after deduplication. Event-only and imported artifacts remain visible. | SQLite and PostgreSQL deduplication/filter tests |
| Expensive thread summary enrichment | Select narrow fields and counts without transferring run logs. Scope active execution queries to returned sessions and batch command reads. | Large-log projection test, batched annotation test, PostgreSQL projection test |
| Unbounded scheduler candidate reads | Fetch keyset pages in priority/due-date/creation/ID order. Continue past ineligible candidates and stop at the dispatch-attempt cap. | Queue pagination test while earlier candidates leave the queue |

The artifact query uses the session's derived artifact array rather than only
`session_artifacts`: event-only and imported records can exist without a content
row in that table. The database still examines matching artifact projections,
but event histories and run logs are not transferred to Python.

Full task responses still include requested histories. Background compact writes
avoid those reads; nested callers that explicitly hold an outer transaction keep
their transaction boundary. Rebuilding an old or mismatched task projection may
still require a one-time history replay.

## Deployment

Run `make backend-migrate` before restarting the backend. Revision
`20260917_0075` adds `(task_id, type, sequence)` to `task_events`, supporting the
latest authoritative ownership-event lookup. PostgreSQL creates/drops this index
concurrently inside an Alembic autocommit block. No event or snapshot backfill is
required. Index operations are retryable after a later migration fails.

Restart all backend replicas together for the admission-lock change. Older
writers use a global lock; new writers use employee-scoped locks. They must not
perform WIP admission concurrently during a rolling deployment. The same applies
when rolling back to the old application version. The extra index can remain
until the application rollback is complete.

## Test evidence

- RED checkpoint: `a39fca29`, seven executed regression tests failed for the
  intended missing behavior. A subsequent API-thread test also failed before
  moving synchronous JSON handlers into the worker pool.
- Focused store, scheduler, lifecycle, and performance suite: 162 passed;
  combined statement coverage for those four runtime modules was 82%.
- API suite plus the initial performance tests: 497 passed.
- Disposable local PostgreSQL 17: seven schema, migration, admission-concurrency,
  projection, and queue-pagination tests passed.
- Production package/web build and TypeScript tests: 1,508 passed; React tests:
  78 passed.
- `npm test`: passed, including 1,592 Python tests. The final focused rerun
  covers session deletion/SSE and performance regressions after the last
  thread-offloading adjustments.
- `npm audit --registry=https://registry.npmjs.org --audit-level=high` and
  `uv run --project backend --with pip-audit pip-audit --local`: no known
  vulnerabilities. The configured npm mirror does not implement the audit API,
  so the audit used npm's official registry without changing user configuration.

Tests use disposable databases. These are work-bound and correctness checks;
they do not establish production p95 latency, throughput, or optimal pool sizing.
