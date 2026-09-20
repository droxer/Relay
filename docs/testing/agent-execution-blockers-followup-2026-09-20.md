# Agent execution blocker follow-up

Update: these findings are now fixed; see [implementation evidence](execution-attention-fix.tdd.md). The audit below records the pre-fix state. The standalone reproduction now delegates to the normal regression suite.

Reviewed 2026-09-20 at `784d23fa`. This is an audit with isolated reproductions,
not a runtime fix. No live sessions, tasks, credentials, or external agents were
used. The earlier findings in `agent-execution-blockers-review.md` describe a
pre-fix checkpoint; their current regression tests pass.

## Findings

### P1 — A queued run's status delivery can prevent its workspace owner from cancelling

Sources: `packages/relay-daemon/src/workspace-run-gate.ts:68–87`,
`packages/relay-daemon/src/index.ts:624–636`, and
`packages/relay-daemon/src/index.ts:1850–1872`.

After acquiring the workspace, the gate awaits every queued waiter's
`onWaiting` callback before starting the owner. In the daemon, each callback
posts `run.workspace` with unbounded retries for transport errors and HTTP 5xx.
It uses the **waiter's** abort signal. Cancelling the owner does not interrupt
that await. The cancellation check and the gate's `finally` block are both
downstream of it.

Trigger: A owns a shared workspace; B and C queue behind it. A finishes. B
acquires ownership and tells C that B now blocks it. C's status delivery keeps
retrying while heartbeat/lease traffic succeeds. B cannot execute, and cancelling
B cannot settle its promise or release the workspace. C and later work remain
queued. This applies to concurrent runs sharing a workspace, such as host-mode
execution; the normal single-slot BoxLite configuration limits exposure.

Reproduction uses the real `WorkspaceRunGate` with three callers and a held
notification promise. After B is cancelled and five event-loop turns drain,
B has neither executed nor settled. Releasing **only C's notification** allows
B to cancel and C to finish. No actual process is running in B. The reproduction
uses the in-memory gate; retention of the optional filesystem lock follows from
the same `finally` block in source.

Recommendation: keep advisory waiter updates out of the owner's execution and
cancellation dependency chain. Bound/serialize their delivery independently and
preserve update ordering. Do not release a workspace early if an agent process
has actually started. Add a three-caller regression for an unresolved notification;
the existing test covers rejection, which `.catch()` handles, but not a pending
promise.

### P2 — One repeatedly failing terminal replay can starve unrelated saved results

Source: `packages/relay-daemon/src/terminal-outbox.ts:63–77`;
replay worker: `packages/relay-daemon/src/index.ts:469–476`.

`replay()` advances its cursor by the entire planned batch before sending it.
A transport exception returns from the whole pass. For a stable backlog of
2–50 records, the next cursor modulo the record count returns to the same first
record. If that record repeatedly times out or resets its connection, later
records are never attempted, even when their requests would succeed.

Reproduction retains two valid terminal events and injects a transport failure
only for the first record in the actual sorted replay order. Four passes attempt
the same command four times and retain both records. A control with successful
transport drains both records, ruling out malformed events or filesystem access
as the cause.

Impact: after a daemon restart, later finished runs can remain without backend
terminal evidence and continue reserving backend execution ownership/capacity.
The records are retained, not lost. This finding specifically requires repeated
transport exceptions for the leading record; ordinary HTTP 4xx/5xx responses do
not take the early-return branch, and a general network outage cannot be solved
by fair scheduling alone.

Recommendation: advance past records actually attempted, or continue a bounded
pass after a per-record failure. Preserve failed evidence and stop promptly on
daemon shutdown. Test fairness for both sub-50 and multi-page backlogs, including
record removal between passes.

## Other boundaries checked

- Admission, cancellation, lease ownership, stale-run reconciliation, and task
  projections passed the focused backend suites on file-backed and SQLite-backed
  fixtures where parameterized.
- Existing daemon regressions passed for pending terminal HTTP responses,
  short leases, explicit poll acknowledgements, long polls, and wrong leases.
- An unconfirmed remote exit still deliberately retains ownership. Lease expiry
  alone is not permission to launch a replacement execution.
- Routing can leave unavailable work queued. A recorded failed dispatch blocks
  the task and requires manual retry; do not use the older review's historical
  exponential-retry description as the current operational contract.
- Startup remains a follow-up inspection target: capability probes are serial
  and precede registration (`index.ts:284`, `:880–900`). Their readiness calls
  have no per-probe deadline, unlike inventory discovery. BoxLite startup also
  precedes its readiness abort check (`index.ts:1362–1364`). These are source-level
  risks, not additional reproduced incidents in this report.

## Reproduction and verification

The standalone reproduction is deliberately outside the normal test suite. It
asserts desired behavior and currently exits with two assertion failures:

```sh
npx tsc -p packages/tsconfig.json
node --test docs/testing/repros/agent-execution-blockers-2026-09-20.mjs
```

Both cases reproduced twice, including their successful recovery controls, in
under 120 ms per invocation. Expected failures:

```text
B remains blocked by C's unresolved notification after B is cancelled
Second result never attempted; four replay passes attempted only ["b","b","b","b"]
```

Existing verification:

- TypeScript compilation: passed.
- `npm run build -w relay-core` and `npm run build -w relay-daemon`: passed.
- Python blocker/lifecycle suites: **64 passed**.
- Python registry, task execution ownership, reconciliation API, and daemon API
  suites: **357 passed**. Existing deprecation and SQLite reflection warnings
  appeared.
- Daemon suite: **168 passed initially**; the installer test failed because the
  package-local `dist/install.js` had not been built. After building the daemon
  package, the installer suite was rerun separately: **4 passed**. This was a verification
  setup issue, not an execution blocker.

Python commands:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_execution_blocker_regressions.py backend/tests/unit/test_execution_lifecycle.py backend/tests/unit/test_blocked_execution.py -q
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_daemon_registry.py backend/tests/unit/test_task_execution_ownership.py backend/tests/api/test_execution_reconcile.py backend/tests/api/test_daemon_api.py -q
```

Node commands:

```sh
node --test dist/packages/relay-daemon/tests/*.test.js
node --test dist/packages/relay-daemon/tests/install.test.js
```

No full repository suite or live BoxLite/agent CLI run was performed. No runtime
source was changed. Fix priority: remove the workspace cancellation dependency
first, then repair terminal replay fairness.
