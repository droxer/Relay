# Thread lifecycle review fixes

The two user journeys came from the review findings: stopping or finishing an
old thread must preserve a newer task execution, and retrying a completion must
repair a partial task write without duplicating the session completion.

## Changes and evidence

| Guarantee | Test | Evidence |
| --- | --- | --- |
| Cancel and Mark Done on an older thread preserve a newer task claim and status | `backend/tests/api/test_backend_review_regressions.py::test_old_round_cannot_settle_newer_task_execution` | Both cases failed before the fix and passed afterward. |
| A completion retry repairs the task transition after a file-backed write failure | `backend/tests/unit/test_controller.py::test_completion_retry_repairs_partial_task_write` | Failed before the fix; passed for automatic completion, human review, and waiting for input after the fix. |
| Repeated completion does not add task events or session completion events | Same completion retry test | Passing snapshot equality and event-count assertions. |
| Completion retries preserve a newer execution claim | `backend/tests/unit/test_controller.py::test_completion_retry_does_not_overwrite_newer_execution` | Passed for both legacy and versioned original owners. |
| Round claims survive daemon request pruning and fence racing claims | `backend/tests/unit/test_thread_task_scope.py` | Covers persisted claims, retained request provenance, mismatched threads/tasks/rounds/revisions, pruned requests, revision-zero compatibility, and task status boundaries. |

RED command:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_controller.py backend/tests/api/test_backend_review_regressions.py -q
```

Result before production changes: 3 failed, 30 passed. Failures were the two
stale-thread decisions and the partial completion write.

GREEN command:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_thread_task_scope.py backend/tests/unit/test_controller.py backend/tests/api/test_backend_review_regressions.py -q
```

Result: 52 passed after adding the boundary cases.

A local Python tracing probe over the unit targets observed 92.3% of statement
lines in `task_scope.py` and 86.1% in the three affected controller methods.
These are scoped statement-line execution measurements, not full-project or
branch coverage. The environment does not have coverage.py installed.

No separate TDD checkpoint commits were created; the inherited changes and
review fixes are collected together for the pull request.

## Full verification

- `npm run test:py`: 2,261 passed, 16 skipped, 2 failed. Both failures are
  controlling-terminal installer tests reporting `/dev/tty: Operation not
  permitted`; no lifecycle regression tests failed. PostgreSQL-dependent tests
  were skipped in this environment.
- `npx tsc -p packages/tsconfig.json` and `npx tsc -p web/tsconfig.json --noEmit`:
  passed.
- Compiled Node tests across core, chat, daemon, supervisor, and web: 1,941
  passed, 1 skipped, 5 failed. Three failures report process/port permission
  restrictions; two are layout assertions in unchanged project page files
  (720px breakpoint and tab ordering).
- `npm run test:react -w web`: all 425 tests in 67 files passed. A redundant
  single-worker retry was interrupted after the default run completed.
- `npm test` and `npm run test:ts`: stopped at Turbopack's local-port permission
  error, including after a permission retry.
- `npm run build -w web -- --webpack`: production compilation, TypeScript
  checking, and static page generation passed.
- `git diff --check`: passed.

No database migration or data backfill is required. Newly recorded task rounds
retain the execution claim in their event-backed manifest. Historical rounds
without that field require a matching retained daemon request; a pruned request
cannot establish ownership and the thread action leaves that task untouched.

Pre-commit dependency audit used `npm audit --registry=https://registry.npmjs.org --json`
because the configured mirror does not implement auditing. It reported 26
findings: one critical, 15 high, four moderate, and six low. This change does
not modify dependency manifests or lockfiles.
