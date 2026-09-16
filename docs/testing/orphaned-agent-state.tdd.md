# Failed threads must not retain running agent projections

## Scope

The two reported live threads had already failed capacity admission but still
contained running agent projections. Their stale projections were repaired
separately after checking execution records and the affected daemon.

This follow-up prevents reproduced variants of that inconsistent state: a thread
can fail while its command is queued, or before the daemon's terminal result is
finalized. Existing admission code checks capacity before creating the next run;
a regression test now explicitly guards that ordering.

## Implementation

- Close a still-running agent projection when finalizing confirmed terminal
  evidence for an already-terminal thread. Preserve its thread outcome, transcript,
  and task state, and do not dispatch a successor.
- When suppressing undelivered work, atomically fence delivery and retain a
  synthetic cancellation result in the run request. Use normal finalization to
  append agent completion before releasing the request. A write failure remains
  retryable instead of leaving an orphan.
- Keep delivered work reserved until daemon exit evidence arrives. No result is
  inferred from a failed session, an expired lease, or missing execution records.

No API, schema, or daemon protocol changes are required.

## RED / GREEN

Journey: a failed thread should become idle once its agent was prevented from
starting or has confirmed exit, while preserving the original failure reason.

`uv run --project backend --extra dev pytest backend/tests/unit/test_daemon_registry.py -k failed_session_closes_agent_projection -q`

- RED: 4 failures; the agent remained `running` after suppressed delivery or
  daemon failure acknowledgement, on both file-backed and database daemon stores.
  Checkpoint: `42041bbc`.
- GREEN: the same 4 tests pass after the fix. Checkpoint: `13e6f9b1`.

Final focused command:

`uv run --project backend --extra dev pytest backend/tests/unit/test_daemon_registry.py -k 'projection_recovery or capacity_rejection_of_next or failed_session_closes_agent' -q`

Result: 8 passed. These cover both store implementations, undelivered and delivered
execution, preserved output/outcome, idempotent reaping, retry after an injected
event-write failure, and capacity rejection between assignments.

The focused registry/lifecycle/deletion suite also passed 267 tests during the
initial implementation. No coverage percentage is claimed for this change.

## Final verification

`npm test` passed: production builds, 1,495 package/utility tests, 76 React tests,
and 1,551 Python tests. `git diff --check` passed. The dependency audit reported
0 vulnerabilities. Historical records with no retained execution evidence still
require investigation; this change intentionally does not guess that they exited.
