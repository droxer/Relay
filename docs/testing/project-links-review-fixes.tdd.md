# Linked project directory review fixes

Journeys come from the project-folder review: two daemons must serialize writes
to the same linked directory; selecting another computer must clear its folder;
and a linked project must never run or browse files through a daemon that cannot
interpret its link.

## RED evidence

Before the fixes, the new lock test observed two simultaneous writers instead
of one, and the drawer interaction retained `/Users/alice/code/app` after a
computer switch. Four Python regressions failed: routing picked an older
sibling, task admission accepted a link without support, browsing selected an
older daemon, and polling delivered a run after a daemon downgrade. Three
additional delivery regressions reproduced list/read/link commands reaching a
daemon after downgrade.

## Guarantees and validation

| Guarantee | Regression | Evidence |
| --- | --- | --- |
| Different daemon roots share a linked directory lock | `packages/relay-daemon/tests/workspace-run-gate.test.ts` | New test failed with peak concurrency 2; passes with 1 |
| Changing computers clears the folder before submission | `web/interaction-tests/projectSetup.test.tsx` | New test failed with retained folder; all 13 interaction tests pass |
| Routing skips older siblings while ordinary projects remain compatible | `backend/tests/unit/test_project_runtime.py` | Failed before fix; passes in focused suite |
| Both new and recorded task workspaces require link support | `backend/tests/unit/test_task_workspace.py` | Failed before fix; passes in focused suite |
| Runs fail safely when support disappears before dispatch or delivery | `backend/tests/unit/test_daemon_registry.py` | Delivery regression failed before fix; both timing cases pass |
| Browsing skips unsupported daemons and queued file operations fail after downgrade | `backend/tests/api/test_project_links.py` | Browsing and three delivery regressions failed before fix; pass afterward |

Commands run:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_project_runtime.py backend/tests/unit/test_task_workspace.py backend/tests/api/test_project_links.py backend/tests/unit/test_daemon_registry.py -q
npx tsc -p packages/tsconfig.json
node --test dist/packages/relay-daemon/tests/workspace-run-gate.test.js dist/packages/relay-daemon/tests/project-links.test.js dist/packages/relay-daemon/tests/thread-workspace.test.js
npm run test:react -w web -- interaction-tests/projectSetup.test.tsx
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_project_links.py backend/tests/unit/test_daemon_registry.py -q -k 'downgrade or loses_link_support'
node --experimental-test-coverage --test dist/packages/relay-daemon/tests/workspace-run-gate.test.js
git diff --check
```

The initial focused Python run passed 370 tests. After adding delivery guards
for file operations and the pre-dispatch downgrade case, all six targeted
downgrade tests passed. The compiled workspace suites passed all 25 tests.
Lock-module coverage is 84.78% lines, 71.26% branches, and 86.67% functions;
remaining branches include existing filesystem error and cancellation paths.
Python coverage tooling is not installed in the repository environment.

## Broader verification

- `npm run test:ts` stalled in the default Turbopack web build and was stopped.
  `npm run build -w web -- --webpack` passed production compilation,
  TypeScript checking, and static export.
- The compiled Node suites ran 2,298 tests: 2,292 passed, five failed because
  the sandbox blocked localhost listeners or process spawning, and one local
  server integration test was skipped for the same restriction. All 54 tests
  in the affected installer/updater/supervisor files passed outside the sandbox.
  The skipped daemon/server integration test also passed outside the sandbox.
- The React suite passed 535 tests and timed out in the unchanged roster test.
  All four roster tests passed on an isolated rerun, covering the remaining
  assertion without changing unrelated code.
- `npm run test:py` finished with 2,838 passed, 22 skipped, and two failures
  caused by the sandbox denying `/dev/tty`. Both installer tests passed on
  an unrestricted rerun (`pytest backend/tests/api/test_computer_installer.py
  -q -k controlling_tty --tb=short`). No feature regressions failed.
- The pre-commit lockfile-only npm audit reported 11 existing high-severity
  advisories, with no dependency changes in this PR. The lockfile matched the
  published public repository before metadata was sent to the npm registry.

No intermediate RED/GREEN checkpoint commits were created while the original
feature was uncommitted. This report preserves that evidence; the feature and
review fixes are submitted together.
