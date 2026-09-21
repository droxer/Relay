# Task deletion uses execution truth

Derived from the reported `Failed to delete tasks task_execution_active` error.
An idle linked thread must not prevent task or routine deletion. A real execution
reservation must prevent deletion even when the thread status says completed.

## Regression evidence

`uv run --project backend --extra dev pytest backend/tests/api/test_tasks.py -q -k uses_execution_truth`

Before the fix: 5 failed, 7 passed. Four cases rejected idle created/waiting
threads with `task_execution_active`; one allowed deleting a task whose completed
thread still held a run request. The same 12 cases pass after the fix.

Task deletion now supplies the execution lifecycle to its linked-thread checks.
Other consumers retain their existing conversation-status policy. Dispatch claims,
owner/admin authorization, admission locks, and transactional routine cascades
remain in place. No schema changes or data repair are needed.

| Guarantee | API regression |
| --- | --- |
| Idle created/waiting/completed threads permit deletion | `test_task_delete_uses_execution_truth`, without reservation |
| Run reservations block task and routine deletion regardless of thread status | Same test, with reservation |
| Active dispatch claims and linked executions remain protected | `test_task_delete_rejects_active_dispatch_and_linked_thread` |
| Routine deletion rolls back when final thread deletion is blocked | `test_routine_delete_cascades_all_occurrence_threads[reserved]` |

## Validation

- Task and thread deletion API files: 61 passed.
- Final deletion selection: 18 passed, including rollback.
- Coverage: 88% of `relay.services.task_deletion`; remaining gaps are missing-record recovery and the unchanged fallback policy.
- Production web build and TypeScript compilation passed through `npm test`.
- Node suite: 1,701 passed, one failed in the unrelated live Kimi inventory test;
  the same test fails on an isolated rerun (`expected ['kimi-live'], actual undefined`).
- `npm audit` could not run: the configured npmmirror registry returns 404 for its advisory endpoint.

Coverage command:

```sh
uv run --project backend --extra dev --with coverage coverage run --data-file=/tmp/relay-task-delete.coverage --source=relay.services.task_deletion -m pytest backend/tests/api/test_tasks.py -q -k delete
uv run --project backend --extra dev --with coverage coverage report --data-file=/tmp/relay-task-delete.coverage -m
```

RED checkpoint: `aef03dcd`. GREEN checkpoint is the fix commit containing this report.
