# Task execution reliability review

Implementation follow-up: all three findings below are addressed on
`fix/task-execution-reliability`. See [regression and verification evidence](../testing/task-execution-reliability.tdd.md).
The findings and measurements below describe the reviewed baseline.

Reviewed commit: `0f07e471`, 2026-11-18. Scope: task scheduling and admission,
backend/daemon delivery and recovery, runtime output capture, completion,
handoff continuity, and browser stream processing. This is a review; no runtime
fixes were applied. No live incident ID was supplied, so these findings are
reproduced implementation defects, not attribution of a particular incident.

## Findings

### 1. P1 — A completed dispatch TimeoutError stalls the scheduler indefinitely

Source: `backend/relay/tasks/scheduler.py:87–98`, caller at `:636`.

`Future.result(timeout=...)` raises `TimeoutError` both when its wait expires
and when the completed operation itself raised `TimeoutError`. `_await_dispatch`
handles both as an unfinished operation. In the latter case every subsequent
call immediately raises the stored exception: the loop spins without waiting,
logs continuously, and never reaches the dispatch-failure bookkeeping. Tasks
are processed sequentially (`:217`), so later candidates and scheduler ticks
also stop progressing. Shutdown awaits this worker (`:190–193`).

Reproduction: create a `concurrent.futures.Future`, call
`set_exception(TimeoutError("The dispatch operation timed out"))`, then pass it
to `_await_dispatch`. A temporary warning callback stopped the probe after
three iterations. Result: `future_done=True`, three incorrect waiting warnings,
and `waited_seconds=180.0` reported immediately. The callback bounds the probe;
without it the loop has no exit.

Recommendation: distinguish a pending wait timeout from the operation's
terminal exception and propagate the latter to the existing failure handler.
Add a regression for a completed future carrying `TimeoutError`, alongside
the existing pending-future test. Avoid cancelling genuinely pending work and
losing its success bookkeeping.

### 2. P2 — Successful Codex replies disappear from handoff context

Source: `backend/relay/sessions/bridge.py:50–89`, consumers at `:225` and
`backend/relay/sessions/handoff_context.py:65`.

Completed-run logs retain raw runtime JSONL. The backend's answer extractor
understands Claude `assistant`/`result` events, but ignores Codex's
`item.completed` with `item.type="agent_message"`. Because `agent_log_for_run`
prefers the completed log, a valid reply becomes `<no output>` in the next
agent's bridge and is marked missing in handoff context. Browser rendering
supports this Codex event, so a visible reply and the next agent's context can
disagree. This can cause repeated work or loss of previous findings; it does
not establish that the browser itself hid the reply.

Reproduction: a completed Codex run whose log contains
`{"type":"item.completed","item":{"type":"agent_message","text":"Verified migration; all checks passed."}}`
produced exactly `[Previous from @codex]\n<no output>` through
`compute_prior_agent_bridge`. The same text in a Claude assistant frame was
extracted correctly.

Recommendation: normalize supported runtime answer frames in the backend and
test real raw logs through bridge, conversation, and handoff-context callers.

### 3. P2 — Long transcript fallback discards its documented beginning

Source: `packages/relay-core/src/nodes.ts:119–124` and
`packages/relay-daemon/src/bounded-text.ts:19–26`.

The documented completed-log contract retains the beginning of long output,
but both process capture and log assembly use tail slices. Above the default
262,144-character limit, the beginning is irretrievable in the completed log.
When live output is incomplete, browser fallback cannot recover that missing
portion. Raw JSONL can also be cut inside a record. This finding concerns
fallback retention; it does not imply loss from a fully delivered live stream.

Reproduction: prefix output with `FIRST-REPLY-MARKER`, append 262,144 characters,
and pass it independently through `runAgentNode` and `BoundedTextCapture`.
Both outputs lacked the marker; capture length remained 262,144. The existing
test named “keeps the head of long agent output” uses only 20,000 characters,
so it never crosses the default boundary.

Recommendation: settle the intended retention policy across both layers,
preserve parseable transcript boundaries, signal omissions, and test above
the configured cap with multiple append patterns. Changing only log assembly
cannot recover data already discarded by process capture.

## Verification

- Core and daemon package builds and `npx tsc -p packages/tsconfig.json`: passed.
- Focused Python dispatch, scheduler, recovery, ownership, capacity, reconcile,
  task API, bridge, and conversation suites: 550 passed (10 + 108 + 405 + 27).
- TypeScript execution, supervision, recovery, buffering, watchdog, command,
  prompt, and renderer suites: 135 passed.
- Browser message, runtime stream parsing, SSE, and poll-merge utility suites:
  213 passed (73 + 140). Logs: `/tmp/relay-task-web-review.log` and
  `/tmp/relay-task-stream-review.log`.
- Real loopback backend + TypeScript daemon E2E: 24 passed. Command:
  `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_daemon_report_e2e.py backend/tests/api/test_daemon_connection_e2e.py backend/tests/api/test_workflow_daemon_e2e.py -q -n 0`.
  Covers duplicate/lost acknowledgements, ingest rollback, terminal replay,
  restart, cancellation, command redelivery, connection failures, revocation,
  workflow failure/retry, and approval gates. Output:
  `/tmp/relay-task-e2e-review.log`.

The E2E harness substitutes deterministic model execution; it exercises the
actual backend, daemon, HTTP, and persistence path. It does not exercise a live
provider, installed agent authentication, BoxLite, or a rendered browser.
Browser utility tests are additional checks, not browser E2E. The full
repository suite and deployed environment were not certified by this review.
The three targeted probes expose gaps that the passing suites do not cover.
All 922 selected tests passed. `git diff --check` passed. Only this review
document was added; runtime source and existing tests remain unchanged.
