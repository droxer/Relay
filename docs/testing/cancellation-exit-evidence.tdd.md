# Cancellation and exit evidence

User journeys were derived from the requested prevention work: cancelling a
thread must stop its owned processes, preserve results across reconnection, and
keep pending deletion blocked until exit evidence arrives. An online computer
must receive process inspection guidance when its execution remains unconfirmed.

## Changes and ownership

- Daemon `execution-capture.ts` observes exit concurrently with stream collection,
  retries failed stop requests, escalates after five seconds, and warns when exit
  confirmation is overdue. Stream draining is bounded only for the supervised
  adapter after verified exit; captured output is preserved.
- `guest-process-supervisor.ts` runs the workload in its own process group,
  escalates TERM to KILL, and verifies cleanup before its SDK execution exits.
  Linux zombies do not count as executing processes. Inaccessible evidence and
  detached writers with inherited pipes retain the execution for reconciliation.
- Host `process-supervisor.ts` cleans descendants on parent exit rather than
  waiting for inherited-pipe EOF. Cleanup timeouts warn and retain ownership.
- A private, fsynced `ExecutionJournal` records command/run/thread/lease identity
  before launch. Restarts fence unresolved starts. Durable terminal-outbox
  evidence clears the journal, including recovery after a crash between those
  operations. Existing output and terminal replay remains authoritative.
- Python lifecycle annotations and the shared `ExecutionStatus` add nullable
  `computerOnline`. English and Chinese recovery guidance distinguishes heartbeat
  liveness from confirmed process exit. API and operating documentation updated.

No database migration, new HTTP route, credential changes, or deployment was
performed. The backend still never executes agents. Session/task events remain
authoritative. No lease expiry, heartbeat, timeout, or journal entry authorizes
execution release or deletion. Existing report-gone confirmation is unchanged.

## RED evidence

- `npx tsc -p packages/tsconfig.json`: new journal/supervisor modules and capture
  options were missing (intended compile-time RED).
- Compiled exit-monitoring test: `false !== true` while output remained open.
- Compiled recovery-guide test: `execution_unconfirmed` instead of
  `online_exit_unconfirmed`.
- Python lifecycle test: missing `computer_online` contract.
- Host inherited-pipe regression: parent exit failed to trigger cleanup.
- Host cleanup-deadline regression: returned before termination was verified.
- Detached-writer regression: guest supervisor exited prematurely; corrected to
  retain execution until the writer closes or an operator reconciles it.

Initial RED checkpoint: `4dee8f43` on `mc/restore-daemon-connection`.

## GREEN evidence

- `npx tsc -p packages/tsconfig.json` and `npm run build -w relay-daemon`: pass.
- Focused capture/journal/daemon coverage run: 113 passed, one existing skip.
  New capture/journal modules: 96.10% lines, 89.29% branches, 92.59% functions.
  Command: `node --test --experimental-test-coverage
  --test-coverage-include='**/execution-capture.js'
  --test-coverage-include='**/execution-journal.js'
  dist/packages/relay-daemon/tests/execution-recovery.test.js
  dist/packages/relay-daemon/tests/execution-journal.test.js
  dist/packages/relay-daemon/tests/daemon.test.js`.
- Final targeted adapter/capture/journal/guest/guide run: 13 passed. The adapter
  test confirms command arguments, environment, cwd, capture, and guardian TERM
  delivery without a hard kill.
- Guest supervisor tests: four pass, including real child processes ignoring TERM
  and a detached writer; Linux live/zombie/unreadable evidence uses a fixture.
- Focused core/daemon/recovery run: 118 passed before the final additional Linux
  fixture; its four-test supervisor target also passes independently.
- Lifecycle, reconciliation, and deletion Python tests: 34 passed, including
  detail/list liveness and unchanged deletion protection.
- Recovery React tests: 61 passed.
- `cd web && npx playwright test -c playwright.recovery.config.ts
  executionRecovery.spec.ts`: nine browser tests pass, including online-computer
  guidance, pending deletion, navigation, and report-gone confirmation.
- `npm run build -w web -- --webpack`: production build passes. Default
  `npm test` / `npm run test:ts` were attempted; Turbopack could not bind its
  internal port in this environment, including an escalated attempt.
- Complete compiled Node suite, with required permissions: 2,000 passed, two
  unrelated failures in unchanged project-page breakpoint/navigation assertions.
- Complete Python suite: 2,292 passed, 16 skipped, two controlling-terminal tests
  failed because `/dev/tty` was denied. Both pass when rerun with permissions.
  The complete suite used the existing installed backend virtual environment
  with `PYTHONPATH=backend`; creating a new environment hit restricted downloads.
- Complete React suite: 428 passed, two timeouts in unrelated roster/task-creation
  tests. Isolated retry passes task creation; roster selection still times out.
- `npm audit --offline --audit-level=high`: zero vulnerabilities.
- `git diff --check`: pass.

## Limits and rollout

These tests reproduce and prevent failure mechanisms; inspection of the original
live execution was blocked, so its exact cause is not confirmed. No running
daemon was restarted or upgraded. New supervision applies after the updated
daemon is deployed; an already running agent does not gain it retroactively.

The guest tests run child processes on the host and exercise Linux process-state
fixtures; a native BoxLite VM was not launched for this change. Owned process
groups are supervised. Processes that deliberately escape into another session,
especially those without inherited pipes, require separate host reconciliation.
Private journal identity aids reconciliation but cannot recreate an SDK execution
handle or prove an agent exited. Durable output/terminal records survive restart;
output not yet captured at an abrupt crash is not guaranteed recoverable.
