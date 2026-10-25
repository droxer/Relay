# Thread record upgrade regression evidence

Journeys derived from the review: a receiver can retry an accepted handoff after
records migrate; a person can browse historical Activity without rerunning a
thread; dispatch preserves checkpoint support when the daemon has not upgraded.

| Guarantee | Regression test | Evidence |
| --- | --- | --- |
| An accepted receipt validates before and after migration; changed migrated bytes still fail | `packages/relay-daemon/tests/handoff-validation.test.ts` | Failed after migration before the fix; passed afterward. Additional tests reject changed originals, symlinks, and unrelated file aliases. |
| Activity combines current and legacy records and keeps real preview paths | `web/tests/workspaceRecordsApi.test.ts` | Six project/task browsing cases failed before the fix; all passed afterward. Ordinary file browsing still makes one request. |
| Historical Activity remains selected and respects a scoped root | `web/interaction-tests/workspaceFilePanes.test.tsx` | React interaction test passed. |
| Older daemons receive legacy record paths for ordinary runs | `backend/tests/unit/test_daemon_registry.py::test_task_and_chat_runs_have_a_shared_checkpoint_path` | Legacy case failed before the fix; both capability variants passed afterward. |
| New-layout handoffs require daemon support; historical accepted contexts remain compatible | `backend/tests/unit/test_workspace_records.py`, `backend/tests/api/test_team_routes.py` | Missing-capability unit case failed before the fix; capability and receipt-version cases passed afterward. |

Validation performed:

- `npm run build -w relay-core`, `npm run build -w relay-daemon`, and
  `npx tsc -p packages/tsconfig.json`: passed.
- `npx tsc -p web/tsconfig.json --noEmit`: passed.
- `node --test` against the built handoff-validation, thread-workspace,
  workspace-records, workspaceRecordsApi, workspaceFileTabs, taskWorkspace, and
  api test files: 123 passed.
- Same target with `--experimental-test-coverage` and coverage includes for
  `handoff-validation.js`, `api-client/workspace.js`, and `workspaceFileTabs.js`:
  98.75% lines, 92.06% branches, 95.83% functions across those modules.
- Focused `daemon.test.js` integration cases for handoff validation, workspace
  reads, generated files, and legacy workspaces: 18 passed. The local permission
  broker needs Unix socket access; these passed outside the restricted sandbox.
- `npm run test:react -w web --` with workspaceFilePanes, recordWorkspaceTabRoot,
  projectWorkspacePage, and routineRunsWorkspace interaction tests: 18 passed.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest` with
  test_workspace_records, test_client_version_parity, test_handoff_receipt,
  test_handoff_context, test_layering, test_module_size, test_daemon_registry,
  and test_team_routes: 445 passed.
- Ruff, backend mypy (372 source files), and `git diff --check`: passed.

No live computer rollout or full repository suite was run. Coverage above is
limited to the specified TypeScript modules.
