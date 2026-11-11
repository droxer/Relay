# Reducing heartbeat and command-poll load

Status: pre-implementation research snapshot; core recommendations subsequently implemented.
Reviewed 2026-11-11 against the current checkout and official documentation.

This is the pre-implementation research snapshot. The core recommendations are
now implemented locally; see the [implementation plan](heartbeat-load-implementation-plan.md)
and [validation evidence](../testing/heartbeat-load.tdd.md) for current behavior.

## Recommendation

First remove full Computer/inventory hydration from routine authentication and
liveness updates, and coalesce ordinary liveness writes across replicas in the
database. Keep command leasing, authoritative authorization, and control changes
synchronous. Measure this before adding a separate liveness table or changing
heartbeat intervals. No throughput or latency improvement has been measured for
these proposals.

## Current implementation evidence

- [`NodeLivenessMixin`](../../backend/relay/daemon_registry/nodes/liveness.py)
  hydrates through `get_node` before authenticated scopes. Its `_mark_seen`
  already throttles ordinary writes with separate seen/poll clocks, preserves
  precise local observations, and immediately persists drain/revival. These
  throttles are process-local, so they do not impose one fleet-wide write budget.
- [`NodeRows`](../../backend/relay/persistence/daemon/nodes.py) reads all node
  columns and agent rows in `get_node`. `_touch_node_liveness` updates only
  timestamps but returns all columns and then queries agents. The patch path
  locks, reconstructs, and saves the full node. Removing inventory *writes*
  alone therefore leaves inventory *reads* in the hot path.
- [`commands.py`](../../backend/relay/daemon_registry/dispatch/commands.py)
  calls hydration and the reaper entry point from `take_commands`. Reaping is
  already throttled and guarded; this is not a full sweep on every poll.
  Lease renewal progress and response observations also fetch commands
  individually; inspect their repeated `get_command` calls as a separate,
  bounded batching opportunity.
- [`daemon_wire.py`](../../backend/relay/api/computers/daemon_wire.py) uses
  keyed wakes plus recovery reads: 6 seconds with a connected notification
  bridge and 2 seconds otherwise, further bounded by lease/liveness deadlines.
  The “Command notification recovery” section of
  [`node-heartbeats.md`](../guides/node-heartbeats.md) still says half a second;
  use the code constants when estimating load. Poll-held heartbeat suppression
  exists through the negotiated `poll-liveness` feature for older peers;
  `durable-reports` peers deliberately retain independent probes to detect a
  blackholed poll connection (see the daemon heartbeat loop in
  [`index.ts`](../../packages/relay-daemon/src/index.ts)). Keep that safeguard.

## Lessons from primary sources

Kubernetes separates frequently renewed, lightweight Node Lease resources from
larger Node status updates. Its documentation describes Lease renewal as
independent of status reporting. **Inference for Relay:** separate the hot
observation projection from configuration/inventory access; this principle does
not require adopting Kubernetes timing defaults or its eviction behavior.
[Source: Kubernetes Node heartbeats](https://kubernetes.io/docs/reference/node/node-status/#heartbeats).

PostgreSQL updates create row versions. HOT can avoid new ordinary index entries
when changed columns are not indexed **and** the old page has sufficient free
space. Relay deliberately leaves its liveness timestamps unindexed, making the
ordinary timestamp update HOT-eligible, not guaranteed HOT. Its source comment
“stays a HOT update” is stronger than the database guarantee. Measure HOT counters
and page pressure before considering fillfactor changes.
[Source: PostgreSQL HOT](https://www.postgresql.org/docs/current/storage-hot.html).

`UPDATE ... RETURNING` returns rows actually updated. An authorization predicate
combined with a timestamp due predicate cannot return the authorized row when
the observation is throttled: zero rows also describes a missing/revoked node.
Do not interpret that result alone as either successful authentication or a 401.
[Source: PostgreSQL UPDATE](https://www.postgresql.org/docs/current/sql-update.html).

`NOTIFY` delivers after commit, folds identical notifications within a
transaction, limits ordinary payloads to under 8000 bytes, and can fail the
notifying transaction at commit if its queue fills. Keep payloads to opaque keys,
exclude tokens, keep listener transactions short, and monitor queue usage.
[Source: PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html).
`LISTEN` must commit before inspecting durable state to avoid its startup race;
registrations end with the session. Reconnection requires another durable read.
**Recommendation:** retain notifications as wake hints and bounded queue reads as
recovery, never as evidence of a lease or authorization.
[Source: PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html).

Amazon recommends jitter for periodic work as well as retries, with stable
per-host offsets for scheduled work, and selecting timeouts from measured
latency rather than guesswork. **Recommendation:** spread routine registration,
recovery reads, and heartbeat schedules with bounded offsets; never jitter a
shutdown drain or allow a renewal deadline to slip past its safety margin.
[Source: Amazon Builders Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/).

## Phased changes

1. **Measure and narrow reads.** Add a store operation returning only the current
   authentication/control projection: identity, token hash, deletion/retirement,
   drain marker, and required lifecycle/version fields. Every authenticated
   request must consult authoritative state; do not introduce a token cache TTL.
   Keep full hydration for registration, configuration changes, and consumers
   that actually need inventory. Narrow ordinary touch results too. Explicitly
   test that an idle heartbeat issues no agent/inventory query, not only that it
   issues no inventory write. Hydration changes must preserve existing merge,
   revival, and optional-setting-clear semantics. Do not pass a partial
   projection to the existing full-record merge: missing configuration fields
   there mean cleared. Command admission still needs fresh capabilities and
   configuration; narrowing heartbeat authentication alone does not justify
   removing that refresh from command polling.
2. **Coalesce ordinary writes across replicas.** Begin with a narrow authoritative
   auth read followed, when due, by a conditional timestamp-only update. Apply
   the due predicate in SQL even when a local clock says due, so another replica
   can win first. Preserve distinct seen and poll due conditions; one must not
   starve the other. Predicate the mutation on still-valid token/control state
   and preserve drains in SQL, so a concurrent control change cannot be undone.
   Return an explicit authorized-but-unchanged outcome. A later fused query is
   acceptable only if it returns the authorized projection even when its update
   CTE updates nothing, and has tested concurrent revocation/delete/drain
   semantics. Do not manufacture a no-op UPDATE to force `RETURNING`: it defeats
   the intended write avoidance. Advance local persistence bookkeeping only
   after a successful durable operation or confirmed already-fresh observation.
3. **Batch active-command bookkeeping.** Reuse one bounded batch of command
   records for renewal progress and response observations where transaction
   consistency allows. Preserve node/lease-id matching and return only the
   expiry actually stored after a successful renewal. A throttled renewal must
   not advertise `now + leaseSeconds` if that expiry was never persisted.
4. **Consider schema separation only after measurement.** A narrow liveness table
   could isolate high-churn timestamps from configuration, following the Lease
   pattern. It adds joins, migration/backfill, and control-state races; require
   evidence that phases 1–3 leave material row/WAL/index pressure. Do not add
   Redis, a second source of lease truth, or slower failure detection by default.

Across all phases, preserve immediate drain persistence, terminal 401/410
behavior for invalid/deleted identities on the next authoritative check,
registration-only lifting of drains, tombstones across restart/re-enrollment,
separate online/dispatchable clocks, and durable command lease expiry. A revoked
or deleted node must receive no new command; a stale local observation must not
resurrect it. Preserve execution reservations until exit evidence or the existing
recorded human assertion path; heartbeat optimization cannot release them.

## Benchmark and acceptance plan

Use disposable local PostgreSQL with the real HTTP/TypeScript daemon probe in
[`daemon_transport.py`](../../backend/tests/benchmarks/daemon_transport.py),
first at 1, 10, and 100 daemons with one and two backend replicas. Its CLI caps
`--daemons` at 100; larger fleets require a separately reviewed harness extension.
Record commit, database version/configuration, hardware, warmup/duration, RTT,
notification state, and active/idle mix. Save raw measurements outside the repo.

Compare identical baseline/candidate runs, including idle polling, active runs,
burst registration/reconnect, dropped notifications, bridge reconnect, and
backend restart. Instrument statement count/type, selected columns and inventory
queries, returned rows/bytes, transactions per daemon-second, pool/lock wait,
backend CPU, WAL bytes, dead tuples and HOT ratio. Measure commit-to-command
receipt and lease-renewal latency at p50/p95/p99, plus persisted observation age;
request count alone does not establish database savings.

Acceptance gates:

- No inventory query on the ordinary idle authentication/touch path; full
  configuration reads occur only at explicitly identified boundaries.
- Alternating requests between replicas cannot multiply ordinary persisted
  observations by replica count inside one due interval. SQL traces establish
  the actual bound; due drain/revival writes are explicit exceptions.
- Wrong/revoked tokens, concurrent drain/delete, missed wakes, expired or
  mismatched leases, and process restart pass focused PostgreSQL concurrency
  tests. Include the authorized-but-not-due result as a distinct case.
- Every accepted lease expiry equals durable storage; no false offline or
  dispatchable result during the documented timing envelope. Size the persist
  interval plus scheduling/network/database/retry margins below the liveness
  timeout, and prove lease renewal remains ahead of persisted expiry.
- Keep existing delivery/recovery timing budgets. Report baseline/candidate tail
  latency and resource changes; agree any numerical regression budget before
  rollout. An improvement in write count cannot compensate for weaker control
  correctness. Retain SQLite coverage for the local supported store behavior.

Roll out read narrowing, write coalescing, and batching independently so each has
an attributable measurement and rollback. This document supplies a design and
validation plan, not benchmark results.
