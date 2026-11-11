# Heartbeat load reduction implementation plan

Status: implemented locally; see [validation evidence](../testing/heartbeat-load.tdd.md).
Deployment and sustained production-scale acceptance remain separate work.
Date: 2026-11-11.
Basis: [research and primary sources](heartbeat-load-reduction.md).

## Outcome and scope

Reduce SQL reads, returned data, and redundant liveness writes for routine
heartbeats without changing the HTTP contract, six-second default probe cadence,
30-second default liveness timeout, or command-poll recovery timing. Preserve
independent probes for durable-report peers.

Implement in four sequential, independently reviewable changes. No database
migration is expected. A separate liveness table, Redis, transport replacement,
and interval changes require a later proposal supported by measurements.

## 1. Establish baseline and executable load checks

Owners: `backend/tests/benchmarks/daemon_transport.py`,
`backend/tests/unit/test_schema_scalability.py`, and
`backend/tests/unit/test_daemon_lease_load.py`.

- Capture SQL statement types, transactions, and inventory reads separately for
  idle heartbeats, command polls, and active-run renewals. Aggregate metrics
  across backend processes; exclude setup and measurement queries.
- Extend existing SQL capture tests to expose inventory reads and repeated
  command lookups. Add candidate behavior assertions alongside each subsequent
  change, so each behavior first fails against its previous implementation.
- Run the existing disposable PostgreSQL probe at 1, 10, and 100 Computers with
  one and two backend replicas. Keep environment, active/idle mix, duration,
  RTT, and notification connectivity fixed between baseline and candidate.
- Save raw results outside the repository. Record SQL/Computer-second, CPU,
  connection-pool waits, WAL bytes, HOT ratio, and dispatch/renewal tail latency.
  Add instrumentation where the existing probe does not expose these metrics;
  record unavailable metrics explicitly rather than infer them.

Exit: a reproducible baseline and query traces identify the work removed by
each change. The existing probe caps fleet size at 100; it establishes no
1,000-Computer capacity claim.

## 2. Give ordinary heartbeats a narrow store path

Owners: `backend/relay/persistence/daemon/`,
`backend/relay/persistence/protocols.py`,
`backend/relay/daemon_registry/nodes/liveness.py`, and
`backend/relay/daemon_registry/dispatch/commands.py`.

- Define an explicit authentication/control projection containing identity,
  credential hash/version, status, retirement, drain marker, and required
  observation/lifecycle fields. Keep it separate from full Computer records.
- Add a store read for that projection, including existing malformed-id handling.
  Authenticate against current database state on every heartbeat.
- Route routine ready-state heartbeats through it. Narrow timestamp-write
  results as well, so neither read nor write loads runtime inventory.
- Introduce an observation merge that updates only supplied observation/control
  fields. Do not pass partial records to `merge_node_observation`, where omitted
  optional configuration means cleared.
- Keep exceptional drain, stopped, revival, and registration behavior explicit.
  Use the existing full-state path where needed initially. Preserve full fresh
  capabilities/configuration reads for command admission.
- Update the store Protocol and registry typing; do not change the public
  `get_node` contract for other callers.

Tests: SQL traces show no agent/inventory read on a normal idle heartbeat;
API responses remain compatible; wrong/revoked tokens, unknown/deleted/retired
Computers, restart revival, and optional-setting clears retain their behavior.

Exit: idle heartbeat authentication is one narrow authoritative read; ordinary
timestamp writes return only needed fields. Benchmark this change separately.

## 3. Share observation-write throttling across replicas

Owners: the narrow persistence operation from step 2 and registry observation
bookkeeping. Add a concern-specific persistence module if needed to stay within
the module/package size budgets.

- Apply the due condition in SQL using persisted timestamps and a common
  database time basis. Local monotonic clocks may avoid unnecessary write
  attempts, but may not decide whether a database write is globally due.
- Keep seen and poll due conditions independent. A fresh heartbeat must not
  starve a due `lastPollAt` update; a poll must not overwrite the drain sentinel.
- Revalidate credential/control state in the mutation predicate. Bypass ordinary
  throttling for actual control transitions such as drain and stopped; preserve
  registration-only lifting of a drain and existing revival rules.
- Return distinct results for updated, authorized-but-already-fresh, missing,
  deleted, and unauthorized states. A zero-row conditional update is ambiguous:
  perform a narrow authoritative reread when necessary to classify it. Keep
  existing 401/404/410 wire behavior.
- Advance local persisted-observation bookkeeping only after commit or a
  confirmed already-fresh durable observation. Failed writes stay eligible for
  retry. Keep precise accepted local observations separate from durable stamps.
- Start with clear read/conditional-update operations. Consider a fused query
  only after this implementation is measured and concurrency-tested.

Tests: alternate and concurrently issue requests through two independent
registries/store engines on PostgreSQL; verify one write per due seen clock
and one per due poll clock across replicas, with transitions excluded. Test
auth-not-due, token rotation, drain/delete races, transaction failure/retry,
restart, and both supported database dialects. Assert outcomes after concurrent
operations commit; do not promise cancellation of an already in-flight request.

Exit: replica count does not multiply ordinary persisted observations; failures
cannot suppress retries or resurrect a drained/deleted Computer.

## 4. Batch command reads and validate the combined result

Owners: registry `dispatch/commands.py`, persistence command reads, and
`backend/tests/unit/test_daemon_lease_load.py`.

- Reuse existing `DaemonStore.get_commands` instead of adding another batch API.
  Fetch one bounded post-renewal command snapshot for submitted lease IDs.
- Share records between renewal-progress bookkeeping and response construction
  where safe. Remove the duplicate per-command `get_command` loops. Retain
  standalone callers through explicit optional batch context or small helpers.
- Filter node ownership, lease ID, and status before recording progress or
  returning observations. Ensure no stale or mismatched lease advances progress.
- Return actual persisted expiry, including when renewal is throttled; retain
  immediate first-delivery acknowledgement and existing terminal observations.
- Keep run-request progress validation and its separate throttle intact. This
  step targets command-record reads, not an unmeasured rewrite of all progress
  storage. Handle large submitted batches with explicit bounds/chunking that
  preserve the existing supported wire contract.
- Persistence `commands.py` is already 769 lines; avoid expanding it past 800.

Tests: empty, multiple, duplicate, mismatched, cross-Computer, expired, superseded,
and terminal command leases; bounded command-query count as batch size grows;
response expiries equal storage. Exercise heartbeat and explicit poll paths.

Exit: repeated per-command reads are removed without weaker ownership checks.

## Verification and rollout

Run focused store, registry, runtime-stability, heartbeat API, transport-security,
and poll-recovery tests after their owning changes. Run PostgreSQL concurrency
tests using the existing disposable-schema fixtures; SQLite alone cannot prove
replica correctness. Check backend layering, module size, Ruff, and mypy, then
the repository Python and TypeScript suites before handoff.

Repeat baseline measurements after steps 2, 3, and 4. Include missed notifications,
notification-bridge reconnect, a blackholed poll, backend restart, and database
errors. Verify observation age stays within the existing liveness budget and
renewal completes ahead of durable lease expiry. Report resource and p50/p95/p99
latency deltas; investigate regressions before rollout. Correct the outdated
half-second recovery text and overly absolute HOT comment in the owning change.

Roll out each change separately, initially to a limited backend instance set,
and observe a representative traffic window. Revert the offending change if
authorization, drain, offline detection, dispatch, or lease correctness regresses.
No migration means rollback uses the previous backend build. No deployment or
external resource change is authorized by this draft.
