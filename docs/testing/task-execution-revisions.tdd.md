# Task execution revisions and stale runtime writes

Journeys derived during this TDD cycle: a superseded execution cannot become
the task owner again after a replacement finishes; its late runtime results
cannot change the task; replay of a rejected recovery remains rejected.

## Checkpoints

- `a0d8f8c1` RED: six store cases failed (missing owner projection, competing
  claims both accepted, missing conditional-write API).
- `f5060731` GREEN: all six store cases passed with atomic event-backed claims,
  idempotent replay, monotonic generations, and legacy-write fencing.
- `4d8ed8bf` RED: real daemon admission did not persist a task execution owner.
- `4fbf375d` GREEN: admission and runtime task writes carry the owner; four
  selected runtime cases passed. Core replay's compile-time RED was also
  resolved; all three core task replay tests passed.
- `54519604` RED / `ae76e2da` GREEN: a superseded request could redispatch after
  its replacement finished; the runtime regression now rejects it without
  adding task events or commands.
- `5361941b` RED / `933fa589` GREEN: API replay returned success for a rejected
  task generation; both requests now return the same ownership conflict.
- `d94aeb3b` RED / `1fd41733` GREEN: an older snapshot could omit ownership and
  reset the apparent generation. The append path now derives it from events;
  all 17 ownership tests passed.

## Guarantees and test targets

| Guarantee | Test target |
| --- | --- |
| One winner per source revision; replay adds no events | `backend/tests/unit/test_task_execution_ownership.py` |
| Stale status, round, and activity writes are no-ops in both stores | Same ownership suite |
| Invalid/batched claims cannot mutate tasks | Same ownership suite |
| Missing legacy projection cannot reset event-backed ownership | Same ownership suite |
| Admission binds owner; stale finalization and redispatch are fenced | `test_task_admission_versions_owner_and_fences_stale_finalization` in daemon registry tests |
| Changed task source rejects admission and idempotent replay | `test_handoff_rejects_replaced_task_generation_and_preserves_rejection` in team-route tests |
| Core replay retains the owner after completion | `packages/relay-core/tests/task-store.test.ts` |

## Verification

The intermediate 356-test run passed. Final verification after the projection
fix passed all 1,291 backend tests in 170.66 seconds. Combined statement/branch
coverage is 100% for `relay.persistence.task_execution`, 89% for the task store,
and 90% across both modules.

```sh
uv run --project backend --extra dev --with coverage coverage run --branch --source=relay.persistence.task_execution,relay.persistence.task_store --data-file=/tmp/relay-task-revision-final-cov -m pytest backend/tests -q --tb=short
uv run --project backend --extra dev --with coverage coverage report --data-file=/tmp/relay-task-revision-final-cov
```

`npm test` passed the production builds, 1,435 TypeScript tests, and 19 React
tests. Its Python process picked up the new legacy-snapshot test before loading
the fix and finished with 1 failed / 1,290 passed; the fresh full-backend run
above resolved that failure. No production code changed after that final run.
`git diff --check` passed. Dependency audit retains three existing advisories
(moderate, high, critical); dependencies were not changed.

## Rollout and limits

Ownership is persisted in existing task events/snapshots, so no new migration
is needed. The earlier active-task reservation migration 0068 is still required.
Upgrade backend replicas together; old backends do not enforce conditional task
writes. Production database claims use the row lock and version CAS; the legacy
local task store uses its in-process lock, not a distributed task lock.

These guards cover runtime task writes, not physical process termination,
filesystem writes, deliberate human edits, or revocation of agent API credentials.
Dispatch bookkeeping has its own claim/reconciliation lifecycle. Stronger
termination and terminal-acknowledgement crash recovery remain separate unfinished
work. No live-agent or browser E2E was performed for this backend/protocol slice.
