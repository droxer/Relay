# Durable task workspaces: verification evidence

Scope: reliability and UI improvements requested in the workspace design
conversation. Isolated project task worktrees/integration remain a follow-up.
The source decision is [ADR-018](../adr/018-durable-task-workspace-bindings.md).

## Guarantees

| Journey | Evidence |
| --- | --- |
| A task keeps its Computer, layout, and path across rounds and daemon replacement | Task resolver unit tests, task admission and workspace API tests |
| Conflicting binding events cannot replace durable workspace ownership | Both local and database task-store tests |
| Unlinking/deleting conversations does not delete the task binding | Task workspace API tests |
| New tasks cannot silently lose continuity on older daemons | Resolver and manual-dispatch capability tests |
| Legacy recorded thread layouts continue in their original directory | Resolver legacy tests; scheduler/controller compatibility suites |
| Live Files distinguish missing, empty, offline, unsupported, and denied | API tests and `web/tests/taskWorkspace.test.ts` |
| Shared workspace waits are visible and clear on acquire | Gate tests and lease-authenticated daemon-event/API integration test |
| A waiting observer cannot fail the run holding the workspace | Gate notification regression test |
| Artifact history keeps versions and serves retained bytes despite newer live edits | `backend/tests/api/test_task_artifacts.py` |

## RED checkpoints

- `3f4194a7`: six focused Python failures and two UI state failures reproduced
  missing durable bindings, replacement-daemon browsing, and distinct states.
- `3acf6d07`: artifact history returned only the newest record; the new gate
  observer test intentionally failed compilation because its API was missing.
- `9e60e5cc`: downloading a historical artifact returned newer live bytes.
- `99b8bba1`: a queued observer exception failed the active workspace owner.

Typecheck hooks were skipped only for the two staged observer RED checkpoints,
which depended on the pending API. The final GREEN commit runs the hooks normally.
No remote resources or agent executions were used for these tests.

## GREEN verification

- `npm test`: **1,362 TypeScript tests passed**, **1,136 Python tests passed**.
  This includes production builds, provider/handoff/rendering tests, daemon,
  supervisor, scheduler, API, event-store, schema, and web tests.
- After the final observer fix: `npx tsc -p packages/tsconfig.json` and
  `node --experimental-test-coverage --test
  dist/packages/relay-daemon/tests/workspace-run-gate.test.js
  dist/web/tests/taskWorkspace.test.js`: **16 passed**.
- Final Python focused run: `UV_CACHE_DIR=.uv-cache uv run --project backend
  --extra dev pytest backend/tests/unit/test_task_store.py
  backend/tests/unit/test_task_workspace.py
  backend/tests/api/test_task_workspace_routes.py
  backend/tests/api/test_task_artifacts.py -q`: **79 passed**.
- Resolver coverage: `uv run --project backend --extra dev --with coverage
  coverage run --source=relay.services.task_workspace -m pytest
  backend/tests/unit/test_task_workspace.py
  backend/tests/api/test_task_workspace_routes.py -q`, followed by
  `coverage report -m`: **98% line coverage**.
- Node coverage: workspace gate **83.85% lines / 69.62% branches**;
  UI state resolver **100% lines / branches**. Gate gaps include malformed
  filesystem locks, permission failures, and less common cancellation paths.
- `git diff --check`: clean.

## Limits and environment findings

The live browser check could not run: Playwright's Chrome extension is missing,
and CUA reports no browser available. A temporary localhost server/database was
created for this check and the server was stopped afterward. UI behavior is
covered by state tests and compilation; visual interaction was not verified.

The configured npm mirror has no audit endpoint. Auditing against
`https://registry.npmjs.org` reported **9 existing advisories** (6 high, 3 moderate).
Dependencies and the lockfile were not changed. Existing Python deprecation
warnings do not fail the suites.

Artifact snapshots retain the existing size caps; missing historical bytes cannot
be reconstructed. Routine browsing across multiple Computers and isolated
project-task workspaces are outside this implementation.
