# Task prerequisites review fixes

The journeys come from the four review findings: owners can safely retry an
interrupted plan apply, every write respects the prerequisite limit, a failed
plan retries as a plan, and malformed setup modes receive a client error.

## RED evidence

Before the fixes, the focused Python run failed five tests and passed 20:
store validation accepted eleven prerequisites, plan apply persisted eleven
prerequisites, an interrupted apply left an unrecorded task, and object/list
mode values raised `TypeError`. The React setup suite failed its new retry
regression because the request omitted `mode: "plan"` (16 other tests passed).

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_task_prerequisites.py backend/tests/api/test_project_plan_api.py -q
npm run test:react -w web -- interaction-tests/projectSetup.test.tsx
```

## GREEN evidence

Plan apply now runs within `mutate_setup`'s locked project transaction. Task
creation, prerequisite edges, queueing, and applied keys commit together;
failure rolls them all back. PostgreSQL uses the existing project row lock,
while SQLite serializes writers with the existing `BEGIN IMMEDIATE` policy.
There is no process-local apply lock or new schema change.

| Guarantee | Regression | Result |
| --- | --- | --- |
| A project write failure leaves no task behind; retry creates one queued task | `test_project_plan_api.py::test_interrupted_apply_rolls_back_tasks_before_retry` | PASS |
| Concurrent applies return the same two task IDs and retain ordering | `test_project_plan_api.py::test_concurrent_plan_applies_return_the_same_tasks` | PASS |
| Direct store validation accepts ten prerequisites and refuses eleven | `test_task_prerequisites.py::test_store_validation_enforces_the_prerequisite_limit` | PASS |
| Plan apply refuses eleven prerequisites and rolls back the new task | `test_project_plan_api.py::test_plan_apply_refuses_more_than_ten_prerequisites` | PASS |
| Object, list, integer, boolean, and unknown string modes return HTTP 400 | `test_project_plan_api.py::test_setup_refuses_invalid_mode_types` | PASS |
| Trying a failed plan again preserves plan mode | `projectSetup.test.tsx`: keeps plan mode when retrying a failed plan | PASS |

The focused backend run passed 49 tests; after adding the concurrent-apply
case, the plan API plus layering and module-size checks passed 21 tests.
The three focused React files passed 65 tests. Ruff, backend mypy (377 source
files), web TypeScript checking, and `git diff --check` passed.

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_task_prerequisites.py backend/tests/unit/test_plan_proposals.py backend/tests/api/test_task_prerequisites_api.py backend/tests/api/test_project_plan_api.py backend/tests/api/test_project_setup_api.py -q
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_project_plan_api.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py -q
npm run test:react -w web -- interaction-tests/projectSetup.test.tsx interaction-tests/projectSettingsPanel.test.tsx interaction-tests/taskAssignee.test.tsx
```

## Limits

Focused API tests used SQLite, including concurrent request and rollback
coverage. Live PostgreSQL, real-agent browser E2E, and numerical coverage were
not measured. Existing uncommitted edits were preserved; no checkpoint commits
were created. The RED/GREEN evidence above is retained for a future PR.

## Broader verification

- `npm run test:py`: 3,150 passed, 32 skipped, four failed. These match the
  handoff's environment failures: bootstrap loads a local admin token, two
  installer tests cannot obtain their controlling terminal, and the no-database
  startup test loads a local PostgreSQL URL. The process was interrupted after
  pytest printed its final summary because it retained background handles.
- `npm run test:ts`: stopped during Turbopack's build because the sandbox denies
  binding its worker port. `npm run build -w web -- --webpack` passed instead,
  as did `npx tsc -p packages/tsconfig.json`.
- The directly invoked full Node suite reported two agent-model-discovery
  failures and stalled; it was interrupted, including a bounded retry. This
  run does not establish a complete Node-suite result.
- `node --test dist/web/tests/taskPrerequisites.test.js dist/web/tests/projectSetup.test.js`:
  all 13 tests passed.
- `npm run test:react -w web`: 641 passed, two timed out. Rerunning
  `interaction-tests/profileImagePresets.test.tsx` and
  `interaction-tests/rosterTabs.test.tsx` in isolation passed all six tests.
- Ruff, backend mypy, web type checking, layering/module-size tests, and
  `git diff --check` passed.
