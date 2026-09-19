# Routine deletion

Derived from the request to delete all associated threads when a routine is deleted.

The task deletion service now includes every occurrence listed on the routine and
all linked threads. Database writes join one transaction. The existing controller
handles thread tombstones, task unlinks, and execution admission checks. Chat
conversation links are cleared. Single and batch web mutations refresh tasks and
threads after settling.

## Regression evidence

`UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_tasks.py -q -k routine_delete_cascades`

Before the fix, both cases failed: completed threads remained readable, and an
active occurrence did not block parent deletion. After the fix, those cases pass.
An additional reserved-execution case proves rollback after earlier threads have
already been deleted within the transaction.

| Guarantee | Test | Result |
| --- | --- | --- |
| Delete direct and occurrence threads, preserve unrelated threads, support repeated deletion | `test_routine_delete_cascades_all_occurrence_threads[False]` | Pass |
| Reject active occurrence work without deleting records | `test_routine_delete_cascades_all_occurrence_threads[True]` | Pass |
| Roll back partial cleanup if the final thread has an execution reservation | `test_routine_delete_cascades_all_occurrence_threads[reserved]` | Pass |
| Preserve owner/admin authorization and dispatch protection | Existing task deletion API tests | Pass |

The complete task API file passed (37 tests before adding the rollback case).
The final deletion selection passed all 6 tests. Coverage measured with:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with coverage coverage run --data-file=/tmp/routine-deletion.coverage --source=relay.services.task_deletion -m pytest backend/tests/api/test_tasks.py -q -k delete
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with coverage coverage report --data-file=/tmp/routine-deletion.coverage -m
```

Task deletion service coverage: 90%. Missing-record recovery branches remain
uncovered. Web TypeScript validation passed through pre-commit. No schema change
or migration is required. Existing deleted routines are not backfilled.

Checkpoint commits: `4b83eab5` (RED), `3cc938d8` (GREEN).

Broader checks:

- React tests: 25 files, 143 tests passed.
- Compiled Node tests: 1,569 passed, 4 failed, 1 skipped. Failures were installer,
  supervisor process lifecycle, and an existing `computer.css` weight-ladder
  assertion; none exercise task deletion.
- Package/test compilation reported an existing incompatible `"state"` comparison
  in `web/tests/listSort.test.ts:241`.
- `npm test` could not complete the production build: Google Fonts access failed
  in the sandbox; a network-enabled retry encountered Turbopack's port-binding
  permission failure.
- `npm audit` was attempted, but the configured npmmirror registry does not
  implement the advisory endpoint.
