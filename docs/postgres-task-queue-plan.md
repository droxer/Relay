# PostgreSQL task queue implementation plan

Status: proposed; implementation has not started.

## Decision and scope

Use PostgreSQL for durable scheduling and task dispatch. Extend the existing
task event store and its relational projections first. Keep the existing daemon
run-request and command queue as the execution delivery layer (ADR-010).

Backlog items become dispatchable only when assigned. Routine definitions create
task occurrences; those occurrences use the same dispatch path as backlog work.
The backend continues to coordinate work exclusively through daemons.

Do not introduce a separate broker or a second authoritative task store.
Initially, the task row is the queue projection. A dedicated queue table can be
introduced later if measured query or contention costs justify it.

## Current implementation evidence

- `backend/relay/persistence/task_store.py`: database dispatch claims lock the
  task row and append claim events. Claims expire and can be recovered.
- The same store promotes a routine and creates its occurrence in one
  transaction. Dispatch selection currently fetches all matching snapshots;
  its optional limit is applied in Python.
- `backend/relay/tasks/scheduler.py`: retry counts and deadlines live in
  `_dispatch_backoff`, using a process-local monotonic clock.
- Scheduler dispatch sends the claim ID as the run request's idempotency key.
  Unknown dispatch failures retain the claim to protect partially accepted runs.
- `backend/relay/services/task_dispatch.py` also claims and dispatches tasks;
  manual and scheduled dispatch must share the new persistence rules.

## 1. Persist retry state through task events

Add focused regression tests first: a failed dispatch followed by scheduler
restart must retain its retry deadline and failure count.

Extend event materialization and task projections with:

| Field | Purpose |
| --- | --- |
| `dispatchAttemptCount` | Actual submission attempts in the current dispatch cycle |
| `dispatchFailureCount` | Consecutive retryable submission failures |
| `dispatchNextAttemptAt` | Durable UTC eligibility deadline |
| `dispatchLastErrorCode` / `dispatchLastError` | Safe, user-visible failure explanation |
| `dispatchCycleId` | Stable identity across retries of one logical dispatch |
| Claim token and expiry | Ownership of one lease, separate from dispatch identity |

Retain or evolve existing claim/outcome events rather than creating parallel
state transitions. Append retry decisions and update queryable projection
columns in the same transaction. Use database time for lease comparisons and
UTC timestamps for persisted deadlines. Inject clocks in tests.

Preserve the existing capped exponential delay initially, adding bounded jitter.
Offline agents and unavailable capacity defer work without consuming the failure
budget. Permanent routing errors block immediately. Propose a configurable
default of 10 consecutive known retryable submission failures before blocking;
an ambiguous acceptance must be reconciled before this rule is applied.

Manual retry after a known failure resets its budget and deadline. Reassignment
or a continuation starts a new cycle only after any previous accepted or
uncertain run is resolved. Execution failures remain governed by existing task
round policy, independently of submission retries.

## 2. Bound selection and make claims safe across replicas

Add an atomic store operation for claiming eligible work:

1. Select non-deleted, assigned, non-routine tasks whose retry deadline is due
   and whose claim is absent or expired.
2. Preserve priority, due-date, and creation-time ordering; add task ID as a
   deterministic final tie-breaker.
3. Apply the batch limit in SQL and use PostgreSQL `FOR UPDATE SKIP LOCKED`.
4. Append claim events and update projections inside the transaction, then commit.
5. Resolve placement and submit work outside the transaction. Revalidate the
   assignment and claim before submission; defer unavailable capacity durably.

Keep batches small enough that their leases do not expire while waiting locally.
Bound candidate processing per tick as well as actual submissions. Deferred tasks
receive a future eligibility time so an unavailable high-priority agent does not
continually consume the front of every batch.

Fence renewals, releases, retry updates, and success updates using the current
lease token. An expired owner must not overwrite a replacement owner's result.
Keep stable dispatch identity separate from the per-lease fencing token.

Add partial/composite indexes for eligibility and ordering, validating their
shape with representative PostgreSQL query plans. Keep any supported non-PG
store implementation behaviorally compatible without claiming equivalent
PostgreSQL concurrency guarantees.

## 3. Close recovery gaps at the daemon handoff

Use the stable dispatch-cycle identity as the daemon run-request idempotency key.
Retrying or reclaiming the same cycle must resolve to the existing durable run
request. A new continuation round gets a new identity.

Handle these crash boundaries explicitly:

| Crash point | Recovery |
| --- | --- |
| Before claim commit | Work remains eligible |
| After claim, before submission | Lease expires; recover the same cycle |
| After durable run acceptance, before task update | Reconcile by cycle identity; attach the existing run |
| After task update, before response | Replay returns the persisted outcome |
| Old scheduler returns after lease replacement | Fencing rejects stale mutation |

Reuse the registry's durable run-request staging and recovery mechanisms. Audit
whether acceptance and task linkage can share a transaction; where they cannot,
use idempotent reconciliation. Do not hold database locks over network I/O.
Delivery remains at least once; this design does not promise exactly-once agent
side effects.

## 4. Make routine behavior explicit

Preserve date-based cadence in the first release. Document and test the existing
missed-run and overlap behavior before changing policy. Proposed defaults for
any policy gaps: coalesce missed dates to one pending occurrence and allow at
most one active scheduled occurrence per routine.

Give scheduled occurrences a unique `(routine_id, scheduled_for)` identity backed
by a database constraint. Audit existing duplicates before enabling it. Keep
manual ad-hoc runs distinct so repeated intentional runs remain possible.

Create the occurrence, append routine advancement events, and make the occurrence
eligible in one transaction. Bound routine promotion batches too. Pausing a
routine prevents future promotion; cancelling an existing occurrence follows
the existing task cancellation path. Avoid introducing cron or timezone policy
changes as part of queue storage.

## 5. Expose actionable queue state

Extend existing task summary/detail contracts with next attempt time, attempt
count, and a waiting reason. Distinguish waiting for capacity, waiting for retry,
dispatch in progress, and blocked. Reuse task retry and cancellation flows where
available; enforce their existing authorization and assignment guards.

Update Python contracts, TypeScript types, task cache merges, Backlog and Routines
views together. Add metrics for eligible depth, oldest eligible age, dispatch
latency, retry counts, expired claims, and routine promotion lag. Keep error
messages free of credentials and raw sensitive request data.

## Delivery order and migration

1. **Durable retries:** event/schema additions, projection backfill, shared retry
   persistence for scheduled/manual paths, restart tests.
2. **Concurrent dispatch:** bounded SQL claims, fencing, stable cycle identity,
   handoff reconciliation, real PostgreSQL race/crash tests.
3. **Routine guarantees:** scheduled occurrence uniqueness, bounded promotion,
   documented policies and migration checks.
4. **Visibility:** API/UI waiting reasons, retry controls, operational metrics.

Use additive Alembic migrations and nullable/defaulted fields. Backfill through
the event/projection conventions, preserving task history. Map existing active
claims to their existing idempotency keys; do not mint replacement identities
for uncertain accepted work. New cycles can use the new identity scheme.

For the initial cutover, stop scheduler dispatch, reconcile outstanding claims,
deploy all backend replicas with the new claim rules, then resume scheduling.
Do not mix old and new dispatch workers unless compatibility is explicitly
tested. Run large index creation concurrently with the required Alembic
transaction boundary. Rollback must stop dispatch and reconcile active cycles
before returning to old claim semantics; preserve new events and columns.

## Verification and acceptance

Primary tests: `backend/tests/unit/test_task_store.py`, `test_task_scheduler.py`,
`test_task_dispatch.py`, registry delivery tests, API tests, and schema-drift tests.
Add real PostgreSQL integration coverage; SQLite tests cannot validate row-lock
or `SKIP LOCKED` behavior.

Required scenarios:

- Retry timing survives backend restart and is shared across two schedulers.
- Two database connections cannot own the same live claim; stale owners are fenced.
- Crashes at every handoff boundary recover without creating a second logical run.
- Two routine promoters produce one occurrence for the same scheduled date.
- Offline tasks remain queued without exhausting retries or blocking ready work.
- Cancellation, deletion, reassignment, and continuation races preserve task state.
- Ambiguous acceptance is reconciled before retry exhaustion or a new cycle.
- Event replay reproduces retry state and migration backfill preserves old tasks.
- Large queues use bounded queries and batches with deterministic ordering.

Run focused tests during each phase, then `npm test`, the complete Python suite,
TypeScript compilation, applicable web build/tests, schema-drift checks, and
`git diff --check` before implementation handoff. Record PostgreSQL query plans
and measured queue behavior; do not claim throughput gains without measurements.

Done means restarts lose no retry state, concurrent schedulers safely share work,
routine promotion is deduplicated, uncertain dispatches recover by identity, and
users can see why an assigned task is waiting.
