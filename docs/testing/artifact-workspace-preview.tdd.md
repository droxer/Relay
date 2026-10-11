# Generated-file preview workspace routing

Journeys were derived from the two findings in the generated-file preview review:
a preview must read from its thread's directory, and it must use the workspace
root recorded by the session even after the daemon placement changes.

## Evidence

- RED: `npx tsc -p packages/tsconfig.json && node --test --test-name-pattern='confines thread workspace reads' dist/packages/relay-daemon/tests/daemon.test.js`
  compiled and executed the new daemon test. Its listing included files from
  the node root rather than only `report.mjs` from the thread directory.
- RED: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_task_workspace_routes.py -q -k preserves_its_recorded_workspace_root --tb=short`
  executed both placement cases. With the original root available, the route
  selected `/other/workspace`; without it, the route returned 200 instead of 503.
- GREEN: the daemon test passed as part of
  `npx tsc -p packages/tsconfig.json && node --test --test-name-pattern='workspace' dist/packages/relay-daemon/tests/daemon.test.js`
  (18 passed). The final test also covers a missing thread ID.
- GREEN: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_task_workspace_routes.py -q`
  passed all 21 cases, including both new placement cases.
- `git diff --check`: passed.
- `npm test`: stopped during the default Turbopack web build because its
  local worker port was denied (`Operation not permitted`), including on a
  retry with elevated execution requested.
- `npm exec -w web -- next build --webpack`: passed, including web TypeScript
  checking and static export.
- Running the compiled package/utility suites directly with `node --test`
  executed 2,082 tests: 2,078 passed, 1 skipped, and 3 failed. The failures were
  the installer's localhost server (`listen EPERM`) and two supervisor process
  tests (`spawn EPERM`, followed by a harness-start timeout).
- `npm run test:react -w web`: 429 passed and 2 timed out in the existing
  task-project creation and roster keyboard tests. Rerunning those two files
  with `npm run test:react -w web -- interaction-tests/taskProjectCreation.test.tsx interaction-tests/rosterTabs.test.tsx`
  passed all 13 tests.
- `npm run test:py`: 2,346 passed, 16 skipped, and 2 failed. Both failures were
  installer controlling-terminal tests whose `/dev/tty` access was denied
  (`Operation not permitted`). All workspace tests passed in the full run.
- Pre-commit dependency audits reported existing vulnerabilities. No dependency
  manifests or lockfiles were changed by this fix. `npm audit --registry=https://registry.npmjs.org --audit-level=high`
  reported 26 vulnerabilities (6 low, 4 moderate, 15 high, 1 critical).
  `UV_CACHE_DIR=.uv-cache uv tool run pip-audit --path backend/.venv/lib/python3.14/site-packages`
  audited the installed backend environment; its findings include development
  dependencies. The local `relay` package could not be matched to PyPI.

## Guarantees

| Behavior | Test | Result |
| --- | --- | --- |
| Thread reads and listings use the thread directory, including when the node root has a same-named file | Daemon thread workspace integration test | PASS |
| A file present only at the node root cannot be read through the thread | Same test | PASS |
| Traversal, invalid thread IDs, and missing thread IDs produce workspace errors | Same test | PASS |
| Artifact reads select the session's recorded root when another root is advertised first | API placement test, original root available | PASS |
| Artifact reads refuse a replacement root when the recorded root is unavailable | API placement test, original root unavailable | PASS |

## Boundaries

The daemon integration test runs the real polling and workspace-read code with
a controlled HTTP transport and temporary files. It does not launch an agent or
a BoxLite VM. The API test exercises authorization and routing against a test
database with controlled placement and dispatch responses. No live browser
preview was exercised, and no aggregate coverage percentage is claimed.

RED and GREEN evidence is preserved here for review and commit preparation.
