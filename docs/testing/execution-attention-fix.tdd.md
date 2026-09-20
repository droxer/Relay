# Execution attention: implementation evidence

Implemented 2026-09-20. The user requested fixes following
[the design](../execution-attention-design.md) and
[the blocker audit](agent-execution-blockers-followup-2026-09-20.md).

## Result

- Blocked task events retain structured cause and execution references. Python
  and TypeScript replay produce the same `attention` shape; summary responses
  retain it. A new reasonless event does not borrow a prior execution's cause.
- Dispatch rejection records its code in the blocked event itself, so a later
  failure to write `dispatchOutcome` does not erase the diagnosis. Session failure
  records the actual session and, where supplied, request/run identity.
- Recovery panels use the recorded source thread and structured code. Unknown
  causes explicitly say that the cause is unavailable. Legacy free-text reasons
  remain readable; missing metadata never implies that execution can be rerun.
- Backend `canRetrySave` / `canReportGone` capabilities distinguish retained
  results from missing exit evidence. The UI gates actions on recovery phase and
  honors explicit capabilities, including unfamiliar reason codes. Reconcile
  refuses to discard a retained finalization result. Existing authorization,
  confirmation, and audit-event requirements remain enforced.
- Workspace owners no longer await another waiter's advisory status delivery.
  Notifications remain ordered per waiter; actual executing work still holds
  the workspace until it settles.
- A request-specific terminal replay failure retains its own record and lets
  the bounded batch attempt other results.

No schema migration is needed for these event/JSON projection additions. Existing
snapshots may lack `attention`, which clients tolerate. This change does not
rewrite historical events, unblock live tasks, or automatically rerun agents.
The design's general actions schema, historical scanning UI, and monitoring
dashboard remain extensions, not prerequisites of these fixes.

## RED and GREEN

RED checkpoint `1b7b8a2a` contains the initial regression tests:

- Two daemon assertions failed at runtime: owner cancellation waited on another
  waiter's pending notification; repeated replay passes never attempted the
  second terminal record.
- Five backend assertions failed because structured reasons/capabilities were
  absent.
- Six React assertions failed: invalid-phase recovery controls and recorded
  execution cause/thread selection. Fifty existing interaction tests passed.

The workspace regression was refined to keep B's agent work cancellable while
testing the same unsettled-promise assertion. This avoids incorrectly requiring
a fixed implementation to delay B's work until the test cancels it. Recovery
controls explicitly release the held notification/transport and show the fixtures
can complete. The former standalone reproduction delegates to the normal suite.

GREEN results:

| Verification | Result |
| --- | --- |
| `npm test` | Package/web production builds, 1,577 Node tests, 152 React tests, 1,743 Python tests passed |
| Final recovery interaction tests with coverage | 60 passed; 100% statements/lines/functions, 99.23% branches |
| Focused backend coverage run | 141 passed; selected attention/lifecycle/dispatch modules 85% statements; new explanation module 100% |
| Daemon workspace/outbox regression and existing seam tests | 12 passed; combined 90.66% lines, 80% branches |
| Browser recovery and task-board flows on the current build | 10 passed |
| Final TypeScript package compile and web production build | Passed |
| `npm audit` against official registry / `pip-audit --local` | No known vulnerabilities |

The full suite preceded the last extra unfamiliar-finalization guard and its
tests. The final backend coverage run, 60-test interaction run, production build,
and browser run cover those final changes. No second full run was needed for
the subsequent documentation and formatting changes.

Commands for the focused checks:

```sh
npx tsc -p packages/tsconfig.json
node --experimental-test-coverage --test dist/packages/relay-daemon/tests/attention-blockers.test.js dist/packages/relay-daemon/tests/workspace-run-gate.test.js dist/packages/relay-daemon/tests/terminal-outbox.test.js
npm run test:react:coverage -w web -- interaction-tests/executionRecovery.test.tsx --coverage.include=src/lib/executionRecovery.ts --coverage.include=src/components/ExecutionRecoveryPanel.tsx
UV_CACHE_DIR=.uv-cache uv run --project backend --with coverage --extra dev python -m coverage run --data-file=/tmp/relay-attention.coverage --source=relay.persistence.execution_attention,relay.persistence.task_lifecycle,relay.services.execution_lifecycle,relay.services.dispatch_failure -m pytest backend/tests/unit/test_execution_attention.py backend/tests/unit/test_execution_lifecycle.py backend/tests/unit/test_blocked_execution.py backend/tests/unit/test_controller.py backend/tests/unit/test_task_store.py backend/tests/api/test_task_kanban_routes.py backend/tests/api/test_session_delete.py backend/tests/api/test_execution_reconcile.py -q
```

From `web/`, after building:

```sh
RELAY_E2E_PORT=5139 npx playwright test -c playwright.recovery.config.ts executionRecovery.spec.ts taskKanban.spec.ts
```

## Verification issues resolved

- The full suite exposed an existing `font-weight: 600` outside the project's
  400/500/700 ladder. The computer platform label now uses 700.
- A browser assertion still expected `/computer`; it now checks the existing
  `/settings/computers` route.
- Port 5124 served a different worktree's old build. That service was preserved.
  The E2E server/config now accept `RELAY_E2E_PORT`; the final browser run used
  an isolated port and the current production export.

## Limits

Tests use isolated stores, controlled daemon transport/execution fixtures, and
browser API fixtures. They do not demonstrate behavior on a live BoxLite guest
or perform an external agent run. Remote processes are never deemed stopped
solely because a lease expired. Reporting an agent gone remains a human assertion
that releases Relay ownership, not a remote process kill.
