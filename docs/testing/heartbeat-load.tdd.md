# Heartbeat load reduction evidence

Date: 2026-11-11.
Source: [implementation plan](../proposals/heartbeat-load-implementation-plan.md).

## Behavior and implementation

As a Computer owner, I need frequent probes to keep failure detection responsive
without repeatedly loading runtime inventory. As an operator, I need backend
replicas to share a durable timestamp-write budget. Lease responses must reflect
persisted ownership and expiry even when requests land on different replicas.

The implementation adds `persistence/daemon/observations.py`, a narrow
authentication/control read and conditional timestamp mutation. PostgreSQL and
SQLite use database time. Seen and poll due conditions remain independent, and
mutations compare the observed credential/version, lifecycle state, and drain
state. A skipped mutation rereads current control state; a fresh authoritative
read can skip the mutation attempt altogether. Local bookkeeping advances only
after successful storage, so errors cannot suppress the next retry.

The registry merges supplied observation fields without clearing configuration.
A newly discovered Computer loads configuration once after authentication;
command admission retains its full refresh. Active heartbeats reuse a bounded
batch of command records after renewal for progress and response construction.
Wrong-lease records cannot record progress. Existing control-transition paths,
probe periods, expiry windows, and wire contracts are retained.

## TDD evidence

RED checkpoint: `d0e6031b` on `mc/check-heartbeat-server-load`.
`test_heartbeat_load.py` executed against the previous implementation:
**7 failed, 2 passed**. Failures demonstrated inventory reads, per-replica writes,
nine command-record SELECTs for four leases, missing observation operations,
and stale missing/deleted identity handling. These were behavior/API failures,
not dependency or collection failures.

GREEN checkpoint: `c78c3ee4` on the same branch. Focused store/registry/API tests:
**435 passed**. Additional clock, failure-retry, ownership, and concurrent-write
coverage was then added and run on both database dialects.

A second RED checkpoint, `604c68c2`, reproduces a boundary case where a poll-only
write at t=6 incorrectly postponed a seen write due at t=20. GREEN checkpoint
`1d8f501a` reconstructs each local deadline from its actual durable timestamp
and database observation age. Its regression passed in a 303-test registry run
and the 20-test PostgreSQL heartbeat/lease run.

| Guarantee | Test target | Evidence |
| --- | --- | --- |
| Idle heartbeats read no runtime inventory and retain configuration | `test_heartbeat_load.py` | SQLite and PostgreSQL PASS |
| Fresh authenticated heartbeats need one narrow SELECT and no UPDATE | `test_heartbeat_load.py` | Both dialects PASS; SQLite transaction setup excluded |
| Replicas share timestamp due conditions; seen cannot starve poll | `test_heartbeat_load.py` | Both dialects PASS |
| Simultaneous writes use separate engine pools and commit only one due update | `test_simultaneous_observations_share_durable_due_predicate` | PostgreSQL rowcounts `[0, 1]`; both return the same durable observation |
| Current revoked/deleted/retired/missing identities are rejected | `test_heartbeat_load.py` | Both dialects PASS |
| A token/version change, deletion, retirement, or drain between read and write is preserved | `test_control_change_between_read_and_touch_is_not_overwritten` | Both dialects PASS |
| Failed writes remain eligible on the next attempt | `test_failed_persistence_does_not_suppress_next_attempt` | Both dialects PASS |
| Four active leases need two command-record reads, rather than nine | `test_active_heartbeat_batches_command_observations` | Both dialects PASS; returned expiry equals storage |
| A mismatched lease cannot advance run progress | `test_mismatched_lease_cannot_record_progress` | Both dialects PASS |
| Poll-only writes cannot postpone the separate seen deadline | `test_poll_only_write_does_not_delay_due_seen_write` | Both dialects PASS, including a 20-second persistence interval |
| API, registry lifecycle, configuration refresh, drain, restart, and recovery remain compatible | Final focused registry/API suite | 445 PASS |

Focused commands executed from the repository root:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_heartbeat_load.py backend/tests/unit/test_daemon_lease_load.py --cov=relay.persistence.daemon.observations --cov-report=term-missing -q
RELAY_TEST_STORE_BACKEND=postgres RELAY_TEST_DATABASE_URL=postgresql+psycopg://localhost/postgres UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_heartbeat_load.py backend/tests/unit/test_daemon_lease_load.py -q
```

Final heartbeat/lease results: **20 passed** on PostgreSQL; the final SQLite
registry/API/coverage run passed **445 tests**. Combined statement coverage of
`observations.py`, registry `liveness.py`, and registry `dispatch/commands.py`
was **85%**. Their individual coverage was 96%, 94%, and 73%, respectively;
the last includes unrelated existing dispatch paths. PostgreSQL additionally
exercises the database-clock branch. These are focused-module measurements,
not whole-backend coverage claims.

Ruff passed. Mypy, run from `backend/` so its project configuration applies,
reported zero errors across 460 source files. Layering/module-size/API-state
checks passed (9 tests). The npm dependency audit against the official registry
reported zero vulnerabilities; the configured mirror's audit endpoint was
unsupported. No dependency manifest was changed.

## Measured database work

Added `backend/tests/benchmarks/heartbeat_load.py`, a loopback-only PostgreSQL
probe that creates/drops only owned scratch schemas. It measures registry work
and deliberately excludes HTTP, autonomous polling, and real agent execution.

Baseline and candidate used PostgreSQL 17.6 on this macOS host, 1/10/100
Computers, 1/2 in-process backend registries, three rounds six seconds apart,
and zero active commands. Registration and hydration were outside measurement.
Each round sent one heartbeat to each replica for each Computer. This deliberately
tests overlapping replica observations rather than modeling a load balancer.

| Computers | Replicas | Requests | SELECTs before → after | Inventory reads before → after | UPDATE statements before → after |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 3 | 9 → 3 | 6 → 0 | 3 → 2 |
| 1 | 2 | 6 | 18 → 6 | 12 → 0 | 6 → 2 |
| 10 | 1 | 30 | 90 → 30 | 60 → 0 | 30 → 20 |
| 10 | 2 | 60 | 180 → 60 | 120 → 0 | 60 → 20 |
| 100 | 1 | 300 | 900 → 300 | 600 → 0 | 300 → 200 |
| 100 | 2 | 600 | 1800 → 600 | 1200 → 0 | 600 → 200 |

Candidate registration timestamps were already fresh on the first round, so
only two rounds needed writes. The replica-independent due predicate also
coalesces the two replicas' ordinary observations in subsequent rounds.
The concurrent PostgreSQL test establishes actual affected-row behavior, beyond
the benchmark's statement counts.

Artifacts: `/tmp/relay-heartbeat-baseline.json` and
`/tmp/relay-heartbeat-candidate.json`. A final repeat after the independent-clock
fix confirmed the 100-Computer/two-replica counts (600 SELECTs, zero inventory
reads, 200 UPDATE statements) in `/tmp/relay-heartbeat-final-candidate.json`.
The benchmark command was:

```sh
PYTHONPATH=backend backend/.venv/bin/python backend/tests/benchmarks/heartbeat_load.py --database-url postgresql+psycopg://localhost/postgres --output /tmp/relay-heartbeat-candidate.json
```

Read reduction is reproducible from the query traces. Timing samples are short
and noisy: the single-replica 100-Computer candidate had higher p95 latency
(10.287 ms versus 3.927 ms), while the two-replica sample improved. No latency,
CPU, or production-capacity improvement is claimed. WAL bytes, HOT ratio,
database-server CPU, returned bytes, and pool/lock wait were not collected in
this probe and remain sustained-load acceptance work. The probe now also emits
p99 for future runs; the original baseline/candidate artifacts predate that
reporting addition.

## Transport and handoff checks

A real TypeScript-daemon/HTTP smoke test used three Computers, two backend
processes, five seconds of warmup, twenty seconds of measurement, and 100 ms
simulated RTT. Result: 18 command samples, 1,673 output samples, no missing
samples, no errors, and no duplicate launches. Command p95 was 194.44 ms;
output p95 was 470 ms. Artifact: `/tmp/relay-heartbeat-transport.json`.

```sh
PYTHONPATH=backend backend/.venv/bin/python backend/tests/benchmarks/daemon_transport.py --database-url postgresql+psycopg://localhost/postgres --replicas 2 --daemons 3 --warmup 5 --duration 20 --output /tmp/relay-heartbeat-transport.json
```

An initial short three-Computer blackhole probe failed to drain its pending
reports before shutdown and recorded two fixture timeouts. This result is
retained in `/tmp/relay-heartbeat-blackhole.json`, not treated as a pass.
Subsequent 90-second single-Computer baseline/candidate probes both completed
with no missing samples, errors, or duplicate launches; recovery took 4.491 s
and 4.969 s respectively. The final code also passed the original three-Computer,
two-replica, 30-second profile: 27 command samples, 2,519 output samples, no
missing samples, no errors, no duplicate launches, and recovery p95 of 4.129 s.
The equivalent pre-change profile recovered in 4.230 s. Fault-period output
latencies exceed the healthy target, as expected; no healthy-latency guarantee
is inferred from these fault probes. Artifacts:
`/tmp/relay-heartbeat-blackhole-final-short.json`,
`/tmp/relay-heartbeat-blackhole-baseline-short.json`, and the
`/tmp/relay-heartbeat-blackhole-{baseline,candidate}-long.json` files.

The full repository run passed 3,168 TypeScript tests, 1,123 React tests,
and the nine vendored dependency tests. `npm test` completed successfully;
Python reported **4,055 passed, 32 skipped** in 610.02 seconds. That run began
before the final independent-clock correction; the final affected-module
coverage run (445 passing tests) and PostgreSQL run (20 passing tests) were
executed after that correction. The production web build and TypeScript
compilation also passed as part of `npm test`.
These short probes do not establish the reference SLO, 1,000-Computer capacity,
or the 20 recovery episodes required for sustained recovery acceptance.

No migration or production deployment is part of this change. Rollback is a
backend code rollback; the daemon protocol and database schema are unchanged.
