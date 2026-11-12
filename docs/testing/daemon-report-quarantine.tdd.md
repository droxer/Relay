# Daemon report quarantine repair evidence

Date: 2026-11-12. Source: a Computer repeatedly logging
`409 Report quarantined; intervention required` for a retained cancellation.
No separate plan file was supplied.

## Confirmed behavior and scope

The retained cancellation's historical rejection marker contained only `400`.
The original backend rejection detail cannot be reconstructed from that file.
An isolated replay of the outbox reproduced a first HTTP 400 followed by the
locally generated HTTP 409, with only one upstream request.

The investigation independently reproduced a defect in batch ingestion:
`ValueError`, `TypeError`, and `KeyError` raised after input validation were
reported as permanent 400s and could leave a partially applied stream group.
These now roll back the group and return 500, allowing durable replay after
the processing fault is repaired. This is a demonstrated cause of false
quarantine, not proof of the historical production 400's exact cause.

As a Computer owner, I need retryable processing faults to recover without
losing output, genuine rejections to retain their reason, and repeated stop
deliveries to leave polling usable without promising retries that are paused.

## RED evidence

After compiling with `node node_modules/typescript/bin/tsc -p packages/tsconfig.json`:

- `pytest backend/tests/unit/test_report_acceptance.py -k failed_replay_group -q`:
  three newly parameterized cases failed with `[400, 200] != [500, 200]`.
- The same file with `-k batch_rejection_includes`: two failures because
  rejection receipts had no `detail`.
- `node --test --test-name-pattern='quarantine preserves|legacy quarantine' dist/packages/relay-daemon/tests/terminal-outbox.test.js`:
  three executed tests failed because no persisted rejection metadata existed.
- `node --test --test-name-pattern='quarantined cancellation redelivery' dist/packages/relay-daemon/tests/daemon.test.js`:
  failed because the paused-retry diagnostic was missing; redelivery continued
  through the generic background error path.
- The explicit-retry tests subsequently failed because retry audits did not
  retain the original rejection. The audit now records it before the marker
  is removed.

The new summary metadata initially also produced an intended TypeScript
compile failure; emitted JavaScript was run to verify the runtime failures.
No checkpoint commits were created; this file retains the RED/GREEN evidence.

## Guarantees

| Guarantee | Test surface |
| --- | --- |
| Internal processing exceptions roll back and remain retryable; another run still progresses | `test_report_acceptance.py`, four failure classes |
| Invalid payloads remain 400 and wrong command ownership remains 409, without recording acceptance | Batch rejection tests |
| Original status, bounded detail and timestamp survive restart for live and batch rejection | `terminal-outbox.test.ts` |
| Historical status-only markers stay isolated and report that detail was not recorded | Legacy quarantine test |
| Explicit retry preserves the refusal in an audit and removes evidence only after acceptance | Live and batch explicit-retry tests |
| Different leases remain distinct; diagnostic text is bounded and has no terminal control characters | Rejection diagnostic test |
| The CLI shows the original reason and the correct Computer/report retry command | `control.test.ts` |
| Redelivered quarantined stops do not resubmit or repeatedly log a retry promise; polling continues | Daemon quarantine integration test |
| Stalled/transient cancellation delivery still polls and retains exit evidence | Existing daemon cancellation tests |

## Validation

Python checks used the existing development environment at
`/Users/feihe/Workspace/Relay/backend/.venv/bin/python` with `PYTHONPATH=backend`.
Node dependencies were reused locally, with workspace packages linked to this
worktree's own compiled output.

- `pytest backend/tests/unit/test_report_acceptance.py -q`: **52 passed, 2 skipped**.
  The skipped cases require PostgreSQL cross-replica locking/commit visibility.
- `pytest backend/tests/api/test_daemon_transport_security.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py -q`:
  **26 passed**.
- `node --test --experimental-test-coverage dist/packages/relay-daemon/tests/terminal-outbox.test.js dist/packages/relay-daemon/tests/report-reliability.test.js dist/packages/relay-daemon/tests/control.test.js dist/packages/relay-daemon/tests/command-tasks.test.js`:
  **90 passed**. Outbox coverage: **93.68% lines, 85.89% branches, 83.93% functions**.
  This is targeted coverage, not 80% coverage of the entire repository.
- `node --test dist/packages/relay-daemon/tests/daemon.test.js`, with local
  port/process permissions: **201 passed, 0 failed**. Includes real HTTP
  outages up to 30 seconds, cancellation, and continued polling. The same
  native/process tests cannot be certified inside the restricted sandbox.
- Full backend suite attempted: **359 passed, 7 skipped, 3 failed** before
  interruption to investigate the failures. All three were installer
  controlling-terminal tests blocked by sandbox permissions; rerunning those
  three with terminal permissions gave **3 passed**. The entire backend suite
  has not been certified by this run.
- TypeScript package/test compilation and the daemon package build passed.
- Backend Ruff passed; mypy passed for all **462** backend source files.
- The Computer installer bundle was rebuilt locally with `node tools/build-computer.mjs`.
- `git diff --check` passed.

## End-to-end follow-up (2026-11-12)

The extended investigation found and reproduced a second defect: a retained
completed/failed command receiving a redundant cancellation report acquired
the thread mutation scope even after the thread had been deleted. The RED
regression failed with `KeyError` from `_session_pk`. That acknowledgement now
uses the authenticated command and exact lease, without accessing a thread
that it does not change. Wrong leases still fail, and the stop acknowledgement
and receipt still commit together.

The new `backend/tests/api/test_daemon_report_e2e.py` runs a real Uvicorn HTTP
server, Python stores, and a separate compiled TypeScript daemon process.
Only Agent Runtime execution is deterministic; network fault injection sits
around actual HTTP requests. PostgreSQL 17.6 ran in a disposable loopback-only
cluster, with independent test schemas. No production database was used.

Results:

- **7 end-to-end tests passed** in 41.57 seconds. Completed task follow-up
  ran 20 times in the same thread: 10 duplicate submissions and 10 lost
  acknowledgements after server commit. All 21 runs launched exactly once;
  each expected output chunk persisted exactly once and the task stayed done.
- Injected `ValueError`, `TypeError`, and `KeyError` after real output writes
  returned retryable 500 receipts, rolled back, and recovered through daemon
  replay without quarantine or duplicate output.
- Cancellation followed by another message, daemon restart, a delayed Stop
  after thread deletion, and restart with an undelivered terminal report all
  recovered. Durable report files drained only after verified acceptance.
- A real deliberate 409 preserved its reason across restart and stayed
  quarantined until an explicit audited retry. Replay then completed the
  original run without executing it again. This test invokes the same outbox
  intervention method as the CLI; CLI rendering/service guards have separate
  unit coverage.
- PostgreSQL report acceptance suite: **55 passed, no skips**; then the added
  completed/failed variants and wrong-lease checks: **2 passed**. The full
  suite at the final revision therefore contains 56 cases, not 57.
- Security/layering/module-size checks: **26 passed**. Ruff passed and mypy
  passed for all 462 backend source files.
- Browser smoke: real static web build, a database schema upgraded through
  all Alembic migrations, real daemon, and Playwright Chromium. Logged in,
  opened a completed task's thread, typed and sent a message, and observed
  the new eight-chunk reply. The backend independently asserted exactly one
  new execution, task still done, and an empty outbox. Evidence is under
  `output/playwright/completed-task-followup.{png,txt}` (local artifacts).
  The Playwright connector lacked its Chrome extension, so the CLI provided
  the browser. The only observed initial console error was expected `/auth/me`
  401 before signing in.

The browser also exposed misleading output wording: `outputTruncated` can
mean output was still pending at terminal reporting, even when later replay
saves every chunk. English/Chinese copy now states that timing accurately,
rather than claiming output was lost. The smoke screenshot predates this
copy-only correction; both translation files were parsed afterward.

Reproduce after building the core and daemon packages:

```sh
RELAY_TEST_STORE_BACKEND=postgres \
RELAY_TEST_DATABASE_URL=postgresql+psycopg://USER@127.0.0.1:PORT/postgres \
PYTHONPATH=backend python -m pytest backend/tests/api/test_daemon_report_e2e.py \
  backend/tests/unit/test_report_acceptance.py -q
```

This certifies the local lifecycle/fault matrix, not production rollout,
real model CLI behavior, long-duration load, or every platform. The original
historical 400 reason remains unknown; its marker did not preserve it.

## Connection management follow-up (2026-11-12)

The user additionally requested end-to-end inspection of daemon/server
connection management and communication. No additional production-code defect
was reproduced in this connection matrix. The previous quarantine fixes remain
in the worktree; this follow-up adds test coverage and an isolated ASGI fault
boundary, not production fault injection.

`backend/tests/api/test_daemon_connection_e2e.py` covers:

| Scenario | Required observation |
| --- | --- |
| Poll 429 / 503 with `Retry-After: 2` | Next poll waits at least 1.9 seconds; no unnecessary registration; later work succeeds |
| Poll connection blackholed, heartbeat still working | Heartbeats continue; Computer stays online but stops being dispatchable after the poll freshness window; re-registration cannot erase that stale observation; delivery recovers |
| Command response lost after the server commits delivery | The exact command in the dropped response eventually executes once; report outbox drains |
| Server listener stopped and a new application/registry created on the same port/database | An active run survives an outage exceeding its three-second lease within configured grace, completes once, and accepts a follow-up |
| Poll 403 / 404 or legacy heartbeat 404 | Re-registration compatibility path recovers without stopping the daemon |
| Real token rotation / Computer retirement | The actual server returns 401 / 410 and the daemon exits successfully |
| Token rotation during execution | Runtime is aborted; server retains the reservation because revocation is not authenticated exit evidence |
| Graceful shutdown with active execution | Runtime stops, cancellation is recorded, Computer becomes stopped, and restart accepts new work |

The stale-poll test shortens server observation windows only; all HTTP calls,
clocks, credentials, SQL, leases, and execution fencing remain real. The lost
response assertion checks the response's command identity, rather than assuming
its delivery attempt counter must increase: explicit delivery recovery may
return the same command and lease. The gate decodes compressed responses only
to check the test assertion; it passes the original bytes unchanged.

Additional evidence:

- Final combined PostgreSQL run: **19 passed in 86.54 seconds** (12 connection
  cases plus the prior 7 report/lifecycle cases), including the strengthened
  online-versus-dispatchable and re-registration assertions.
- **57 daemon communication regressions passed**, including real HTTP outages
  of 1, 5 and 30 seconds, heartbeat scheduling, polling, lease handling,
  cancellation, shutdown and diagnostic backoff.
- **70 selected backend regressions passed on SQLite**. Trying the same
  selection on PostgreSQL gave **49 passed, 21 failed**: all 21 failures were
  foreign-key violations during old fixture setup (`daemon_nodes.user_id`
  references an Alice user those fixtures never create). They do not reach
  their connection assertions, so that run is not certified as green. The new
  end-to-end fixtures create users through the real API and run on PostgreSQL.
- Two actual backend processes and three daemon workers, randomized routing
  per HTTP request, 30 ms injected RTT, 20-second measurement plus warm-up,
  and a three-second acknowledgement-loss episode: **9 measured commands,
  183 output acknowledgements, zero missing commands/output, zero duplicate
  launches, zero recorded errors**. All three workers recovered; measured
  p95 recovery was **642 ms** after the fault ended. Output acknowledgement
  p95 was **3,318 ms** during this fault run; this is not a healthy-latency
  or fleet-capacity certification. Raw artifact:
  `/tmp/relay-connection-two-replicas.json`.
- Ruff and `git diff --check` passed for the added harness/tests. This follow-up
  changes no production TypeScript/Python API or runtime implementation.

Run the connection and report matrices together after building the packages:

```sh
RELAY_TEST_STORE_BACKEND=postgres \
RELAY_TEST_DATABASE_URL=postgresql+psycopg://USER@127.0.0.1:PORT/postgres \
PYTHONPATH=backend python -m pytest backend/tests/api/test_daemon_connection_e2e.py \
  backend/tests/api/test_daemon_report_e2e.py -q
```

The multi-process probe uses `backend/tests/benchmarks/daemon_transport.py`
with `--replicas 2 --daemons 3 --warmup 2 --duration 20 --rtt-ms 30
--fault ack-loss --fault-seconds 3`. These are loopback tests with deterministic
Agent Runtimes, not public-network DNS/TLS/proxy, production rollout, real model
execution, or long-running fleet-load validation.

## Deployment boundary

No schema migration is needed. Batch receipt details are optional, and new
daemons still read historical numeric quarantine markers. Ownership checks,
payload-bound acceptance proofs, explicit discard acknowledgement and private
file permissions remain in place.

Deploy the backend repair and update the Computer client before retrying any
affected historical report. Stop the daemon, use the exact report ID shown by
`relay reports` with `relay retry-report --report <id>`, and start it again.
Retry is audited; arbitrary permanent failures are not automatically bypassed.
No production service, installed Computer, or actual retained report was
changed during this implementation.
