# Task thread deletion review fixes

The journeys come from the reported deleted-task threads and the subsequent
review: a failed cascade must preserve artifact snapshots, and concurrent
deletions of all tasks sharing a thread must remove that thread.

## Changes

- Store transactions collect cleanup callbacks and execute them only after the
  outer commit. Both database session deletion paths use this for blob cleanup.
- Task deletion uses the existing resource transaction with a common deletion
  key, acquired before reading or changing tasks. PostgreSQL serializes these
  low-frequency mutations across replicas; SQLite reserves its writer first.
- Execution checks, task authorization, and live shared-thread preservation
  remain in the deletion path. No schema migration or frontend API change.

## RED / GREEN evidence

- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest
  backend/tests/api/test_tasks.py -k rollback_preserves -q`: both ordinary and
  routine rollback tests failed because the saved artifact read as `None`.
  Both pass after the fix, including a successful retry that removes the blobs.
- `backend/tests/unit/test_artifact_blob_storage.py` adds commit/rollback cases
  proving blobs remain until the outer transaction exits. Both failed before
  the fix because cleanup occurred inside the transaction, then passed.
- `RELAY_TEST_DATABASE_URL=<disposable PostgreSQL URL> UV_CACHE_DIR=.uv-cache
  uv run --project backend --extra dev pytest
  backend/tests/unit/test_task_deletion_concurrency.py -q`: failed before the
  fix because the shared thread still existed; passed after the fix. Two
  independent transactions synchronize after their task tombstones to exercise
  the overlapping-delete race. The test uses an isolated schema and drops it.
- Complete task API and artifact blob targets: **63 passed**.
- Session and task store targets: **93 passed**.
- Coverage across `relay.persistence.store_common` and
  `relay.services.task_deletion`: **81%** (80% and 87% respectively).
- `git diff --check`: clean.
- Full backend suite (`UV_CACHE_DIR=.uv-cache uv run --project backend --extra
  dev pytest backend/tests -q`): **2,652 passed, 18 skipped, 2 failed**. The two
  failures are the sandbox-restricted installer tests described below; their
  separate unsandboxed run passed. The PostgreSQL regression is among the
  default skips and was verified separately against the disposable database.

## Environment limits

- `npm test` stops during the TypeScript build: this worktree lacks installed
  Node dependencies, so `tsc` is unavailable.
- Two controlling-terminal installer tests fail inside the sandbox because
  `/dev/tty` access is denied. Both pass when rerun outside the sandbox.
- The pre-commit `npm audit --registry=https://registry.npmjs.org` reports
  11 high-severity dependency findings. This change does not modify dependency
  manifests or the lockfile.
