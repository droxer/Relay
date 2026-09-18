# Agent execution blockers review

Reviewed 2026-09-18. Scope: task dispatch and retry policy, placement and
capacity validation, daemon admission, lease renewal, terminal delivery,
session-to-task projections, and unblock/recovery routes. This is a source
review with isolated reproductions; no live task records were inspected or
changed. Runtime code is unchanged.

## Findings

### P1 — A finished run can reject the next command as capacity exhausted

Source: `packages/relay-daemon/src/index.ts:548`, `:657`, `:1177`, `:1580`;
`packages/relay-daemon/src/terminal-outbox.ts:35`.

The daemon retains a terminal event before posting it, but keeps the command
in `activeRuns` until the entire execution promise finishes. The backend can
accept that terminal event, release its reservation, and deliver the next
command while the completion HTTP response is still in flight. The daemon's
capacity check counts the finished command and sends `run.failed` for the
new command. This can interrupt an ordinary sequential pipeline or unrelated
work scheduled into the freed slot.

Reproduced with capacity one: finish command A, hold its completion HTTP
response after acceptance, then deliver B through the concurrent poll.
Observed A `run.completed`, followed by B `run.failed` with exactly
“Daemon node has no available execution slot for this run.” No agent process
was still executing when B was rejected.

Recommendation: distinguish process/workspace occupancy from terminal-event
delivery bookkeeping. Once execution is settled, pending result delivery
must not count as an occupied execution slot. Preserve the outbox and
workspace serialization guarantees. Add a test with a delayed terminal
response and a newly admitted command.

### P2 — Poll renewals do not renew the daemon execution watchdog

Source: `packages/relay-daemon/src/index.ts:426`, `:475`, `:507`, `:592`;
`backend/relay/api/daemon_node_routes.py:625`.

The command poll supplies active leases, and the backend renews them before
and during long polling. The daemon only updates its watchdog from heartbeat
responses; command poll responses contain no renewal acknowledgement. The
allowed command lease minimum is one second, independent of the normally
five-second heartbeat interval. A healthy run with a short configured lease
therefore aborts before the first renewal heartbeat even while polling works.
The same disconnect matters when the heartbeat endpoint is unavailable but
command polling continues renewing ownership.

Reproduced with `commandLeaseSeconds=1`, heartbeat interval 5,000 ms, and
successful repeated command polls carrying the active lease. The run emitted
`run.cancelled` with exactly “Execution lease expired; stopping until
ownership can be confirmed.” The isolated transport did not emulate durable
backend renewals; backend renewal behavior was separately verified in source.

Recommendation: negotiate lease and heartbeat timing together and make
renewal acknowledgements explicit on every supported renewal path. Never
extend a watchdog merely because an arbitrary poll succeeded: it must confirm
the same command and lease. Test short leases and heartbeat-specific outages.

### P2 — Temporary capacity loss terminally fails an admitted continuation

Source: `backend/relay/daemon_registry/registry.py:2944`, `:2956`, `:3799`,
`:4233`; `backend/relay/sessions/controller.py:228`.

`_enqueue_current_assignment` treats exhausted capacity like a permanently
invalid placement and invokes `_fail_run_request`. That fails the session and
blocks its task, with no queued continuation left for recovery. Initial
routing, by comparison, defers work when capacity is unavailable.

Reproduced using real local stores and registry calls: admit two runs at
capacity two; re-register the node at capacity one; complete the first step
of a two-step task while the other run remains active. The task immediately
becomes `blocked`, its session becomes `failed`, and its reason is exactly
“Agent placement is no longer eligible: Runtime node capacity is exhausted.”
The second assignment never executes. No capacity predicate was mocked.

Recommendation: preserve the assignment index, state, workspace, and task
ownership while waiting for capacity. Retry only the undelivered assignment
when capacity becomes available. Keep permanent placement invalidation and
execution with uncertain ownership on their separate failure/recovery paths.

## Deeper review: four additional findings

The following reproductions ran against both file-backed and SQLite-backed
stores. They are additional to the three findings above.

### P1 — Expired execution is redelivered without confirming process exit

Source: `backend/relay/persistence/daemon_store.py:797`, `:826`, `:2427`,
`:2523`, `:3645`; `backend/relay/daemon_registry/registry.py:2273`.

Both command stores make a dispatched command available again when its lease
expires. Unless stop intent has already been recorded, polling assigns a new
lease and returns the same `run.start`, without any terminal evidence for the
old execution. A replacement daemon has no in-memory `activeRuns` entry and
will execute it. A daemon crash does not prove its child process stopped, so
this permits duplicate execution with unconfirmed ownership.

It also breaks recovery of an already-completed result: once the lease is
rotated, replay of the old lease's fsynced terminal event is rejected. The
outbox preserves evidence, but cannot finalize the request under that lease.

Reproduction: dispatch once with a short lease, send no terminal event or
renewal, let it expire, and poll in explicit-lease mode. Both stores returned
the same command with a new lease. Posting its original `run.completed`
raised “command lease does not match the active command”; the request stayed
active. This test establishes redelivery and rejection, not actual concurrent
external side effects.

This contradicts `docs/testing/execution-lifecycle.tdd.md`, which says an
unresponsive execution is deliberately not redelivered before its exit is
confirmed. Recommendation: separate delivery recovery from execution recovery;
retain the ownership reservation for possibly-started work and reconcile
process/terminal evidence before creating another execution attempt. Do not
fix this by accepting arbitrary stale terminal events over a newer owner.

### P1 — Skipped expired starts can starve every cancellation command

Source: `backend/relay/persistence/daemon_store.py:797`, `:804`, `:2437`,
`:2462`; `packages/relay-daemon/src/index.ts:1570`.

Both stores apply the poll limit before filtering expired `run.start`
commands that already have stop intent. Those records are skipped without
being removed from the next query. When they fill the first page, the newer
`run.cancel` commands are never reached. Subsequent polls repeat the same
empty result indefinitely. The daemon requests a limit of ten.

Reproduction: admit and deliver ten concurrent runs, let their leases expire,
and request cancellation of all ten. Three consecutive polls with limit ten
returned zero commands, although the store reported twenty available records.
A diagnostic poll with limit twenty immediately returned all ten cancels.
Both stores produced the same result. The test used explicit lease polling
without active renewals, as on a reconnect with no known active commands.

Recommendation: exclude suppressed starts before limiting the query, or page
past them, and ensure cancellation traffic cannot be starved by starts.
Retain reservations until actual terminal evidence arrives; skipping delivery
is not itself proof that a process stopped.

### P1 — Failure recovery can leave a task running with no execution

Source: `backend/relay/sessions/controller.py:224`;
`backend/relay/daemon_registry/registry.py:2667`, `:3522`, `:4233`.

`fail_session` commits `session.failed` before recording the linked task's
blocked status, without the transaction wrapper used by completion and
cancellation. If the task write fails, recovery treats the terminal session
as authoritative and closes the run request without repairing the task.
The task remains `running`, has no blocker reason or active execution, and
is not eligible for the assigned-task scheduler.

Reproduction: start a two-assignment task, disable its executor before the
first assignment finishes, and inject a task-store exception only for the
subsequent blocked-status write. Restore writes and run recovery. Both stores
ended with `session=failed`, `task=running`, no blocker reason, and no active
run request. The SQLite reproduction used the same engine for session and
task stores, so an available shared transaction did not prevent the defect.

Recommendation: make session failure and its task projection atomic when the
stores share a database, and make recovery idempotently restore a missing
task transition under the original execution-owner fence. A terminal session
must not silently excuse an incomplete task transition.

### P2 — A disabled executor is treated as ambiguous dispatch acceptance

Source: `backend/relay/persistence/agent_placement_store.py:1017`;
`backend/relay/daemon_registry/node_backend.py:693`;
`backend/relay/services/agent_routing.py:26`;
`backend/relay/tasks/scheduler.py:651`.

Placement readiness checks executor health but ignores `disabledAgents`.
Routing therefore selects a deliberately disabled executor and claims the
task. Admission rejects it before creating any run, but its plain-text
`ValueError` is classified as `dispatch_failed`. That classification means
acceptance might have occurred, so dispatch retains the claim instead of
releasing it. The manual dispatcher uses the same classification policy.

Reproduction: disable Codex on the assigned node and tick the scheduler.
Both task stores recorded `queued / dispatch_failed`, retained a dispatch
claim, and had no active run request. Re-enable Codex and immediately tick
again: zero tasks dispatch because the unnecessary claim remains live. Its
default lifetime is sixty seconds. Leaving it disabled causes repeated
claim/expiry cycles without the classified retry policy.

Recommendation: honor disabled executors during placement selection and
return a typed, known-not-admitted failure at the final admission boundary.
Release the claim for that definite rejection while preserving claims for
genuinely ambiguous acceptance.

### Additional checks that did not establish a defect

- Finalization failure counters do **not** carry into the next assignment.
  Injecting four failures, recovering the first assignment, then failing the
  next assignment once produced a fresh failure count of one and did not
  require manual recovery, on both daemon stores.
- A crashed/unreachable daemon cannot safely be declared stopped merely
  because its command is absent from a replacement daemon's memory. No
  recommendation here relies on that assumption.

## Blocker inventory and recovery behavior

| Category | Current behavior | Assessment / recovery |
| --- | --- | --- |
| `Execution needs attention.` | Task materialization fallback when neither the event nor existing task provides a reason. | Not a root-cause diagnosis. Current dispatch regressions cover specific reasons for disabled agents, missing teams/projects, and exhausted retries. Historical records are not repaired automatically. Inspect authoritative task events and linked session outcome before changing the record. |
| Agent/team/project missing, disabled, forbidden, incompatible, or unsupported policy | Permanent routing failures block tasks with a recorded reason. | Fix the assignment/configuration/access issue, then explicitly unblock or resume as appropriate. |
| Node offline, executor unavailable, workspace affinity unavailable, provisioning pending, initial capacity shortage | Routing generally leaves work queued and records a dispatch outcome. | Restore the assigned runtime/workspace or capacity. Scheduler can try again. These do not all become `blocked`. |
| Classified failures after dispatch selection | Persisted exponential retry; default budget is ten failures. Exhaustion blocks the task. | Inspect the last error and retry after correction. WIP refusal and ambiguous acceptance are excluded from this failure budget. |
| Task WIP limit or an existing dispatch/execution owner | Refuses/defer admission; protects existing ownership. | Finish/accept existing WIP or settle the active execution. Do not bypass ownership checks. |
| Daemon has no execution slot | Emits terminal `run.failed`. | False-positive completion window described in finding 1. |
| Placement becomes ineligible between assignments | Fails the run request/session; linked task is blocked. Includes capacity, liveness, readiness, disabled executor, and logical placement changes. | Capacity should wait as described in finding 3. Permanent configuration changes require correction. |
| Invalid workspace, missing capability, preflight/auth failure, skill preparation failure, agent exit failure, lost output | Daemon/registry records failure; session failure blocks linked work, subject to pipeline repair/continuation policy. | Correct the specific reported failure. Preserve generated work and inspect the transcript before rerunning. |
| Execution lease expiry | Watchdog aborts; cancellation blocks the linked task after terminal handling. | Stop on genuinely unconfirmed ownership is intentional. Finding 2 covers false local expiry. Ownership must be settled before replacement execution. |
| Cancellation / human stop | Session cancellation projects a blocked task with the stop reason. | Intentional, not an infrastructure fault. |
| Agent reports blocked, lacks required verdict/evidence, or needs human input | Can become `waiting_for_human`; human acceptance can become `review`. | Distinct from infrastructure `blocked`; inspect the round result or requested input. |
| Terminal result persistence fails repeatedly | Retains terminal evidence and enters `recovery_required`; ownership remains reserved. | Recovery endpoint retries finalization. Lease expiry alone is not evidence that a remote process exited. |

Unblocking restores `blockedFromStatus`; a previously running task becomes
`waiting_for_human`. Unblock does not itself dispatch an agent. The scheduler
does not automatically retry tasks while their status remains `blocked`.

## Verification

- `npx tsc -p packages/tsconfig.json`: passed.
- `npm run build -w relay-core`: passed (needed for compiled daemon imports).
- `uv run --project backend --extra dev pytest backend/tests/unit/test_blocked_execution.py backend/tests/unit/test_daemon_registry.py -q`: **272 passed**.
- `node --test dist/packages/relay-daemon/tests/execution-watchdog.test.js dist/packages/relay-daemon/tests/terminal-outbox.test.js dist/packages/relay-daemon/tests/daemon.test.js`: **91 passed**.
- Isolated temporary daemon harness reproduced findings 1 and 2 using a fake
  executor and controlled HTTP responses; no external agent CLI was launched.
- Isolated Python harness reproduced finding 3 using local stores and actual
  registry admission, registration, and completion calls.
- Full repository tests and live multi-process/network fault tests were not
  run. The passing suites above do not establish that the reported timing
  windows are covered.
- Additional deep-review suite:
  `uv run --project backend --extra dev pytest backend/tests/unit/test_execution_lifecycle.py backend/tests/unit/test_task_scheduler.py backend/tests/api/test_session_delete.py -q`:
  **56 passed**. Warnings concerned Starlette TestClient deprecation and
  SQLite expression-index reflection.
- Additional isolated reproductions exercised real registry/store calls for
  expired delivery, cancellation starvation, and disabled-executor recovery.
  The task-projection reproduction injected a blocked-status write failure,
  restored the store, and checked the result after normal recovery. These
  probes reproduced current defects; production source and suite assertions
  were not modified.
