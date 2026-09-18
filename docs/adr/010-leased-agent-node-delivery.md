# ADR-010: Explicit Leases for Agent-Node Delivery

## Status

Accepted. Execution recovery policy amended 2026-09-18.

## Context

Relay's control plane and daemon nodes communicate over HTTP across process and
network failure boundaries. A poll response can be lost after the backend has
claimed a command, a daemon can restart without its in-memory run map, and a
cancel response can disappear before the daemon sees it. Treating either
backend memory or one response write as proof of delivery can strand work.

Exactly-once execution is not achievable across this boundary without moving
durable execution state and transactional side effects into the worker, which
would conflict with ADR-009. Relay instead needs explicit ownership and
idempotent, at-least-once messages.

## Decision

- The backend remains the durable owner of commands and run state.
- Command polls claim available work with a bounded lease and return a stable
  command id, a per-delivery lease id, an expiry, and an attempt number.
- Current daemons poll with `leaseMode=explicit` and report the command id and
  per-delivery lease id for work they are actually executing. The backend
  renews only matching deliveries directly against the durable store, so the
  heartbeat may land on any backend replica without allowing an expired
  delivery to renew its replacement.
- Missing heartbeats do not prove process exit. A delivered `run.start` keeps
  its command and lease identity after expiry and is not automatically
  redelivered. Its execution reservation remains until terminal evidence is
  received. Saved terminal events from that lease can still settle the run.
- Non-executing commands, including cancellation and workspace reads, remain
  eligible for leased redelivery. Expired starts are excluded before applying
  the poll limit so they cannot starve cancellation traffic.
- Poll responses include matching lease observations and server processing
  duration. Daemons use confirmed observations from both polling and heartbeat
  responses, accounting for transport time without counting the server's
  long-poll wait as network latency. Heartbeat cadence is bounded by the
  requested execution lease duration.
- Legacy pollers may omit `leaseMode`; during migration, the backend preserves
  their server-inferred renewal behavior.
- `run.cancel` is a leased command. It is not acknowledged by being returned in
  a poll response. It remains retryable until the target run becomes terminal,
  at which point all matching cancel commands are completed.
- Daemons deduplicate active `run.start` commands by command id. Output is
  deduplicated by run, stream, and sequence. Terminal events are idempotent at
  the backend boundary.

## Consequences

- A daemon crash or lost start response can leave execution unconfirmed.
  Restoring terminal evidence or reconciling the execution host is required;
  expiry alone never authorizes a replacement process.
- Database timestamps are normalized as UTC at the persistence boundary so
  lease and run ages do not depend on the backend host timezone.
- Lost cancel responses are retried and cannot silently leave a run executing.
- Non-executing delivery remains at least once. This protocol does not claim
  transactional exactly-once external side effects.
- The default command lease is 60 seconds. The watchdog stops execution when
  its ownership can no longer be confirmed; backend capacity remains reserved
  until process exit is acknowledged.
- A future protocol version can remove legacy inferred renewal after old
  daemons are no longer supported.
