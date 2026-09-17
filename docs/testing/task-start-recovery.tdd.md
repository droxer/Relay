# Task start recovery — TDD evidence

## Intent

The user requested fixes for two reproduced admission failures:

- Starting a project task while its runtime is unavailable must queue it for
  the scheduler to retry when the runtime recovers.
- A task with a pre-created idle thread must be able to start an agent; an open
  thread alone is not evidence of an active execution.

The implementation preserves the execution-plane boundary and event-backed task
updates. It does not change credentials, protocols, schemas, or frontend caches.

## Reproduction and implementation

Initial API regressions failed before the fix (`ed4ac874`). The project returned
queued while remaining in backlog, and pre-created threads were refused as
active executions. A subsequent unit reproduction showed that workspace routing
also rejected a never-executed thread with no computer binding.

The fix (`04182144`):

- Promotes transient project and project-agent routing failures to assigned.
- Uses live task/session run requests and dispatch claims to guard manual starts.
- Lets a never-admitted, never-executed thread select its initial computer and
  freezes that computer in the task's workspace-binding event during admission.
- Preserves the original thread and workspace convention. Recorded computers,
  execution ownership, started tasks, and execution history still prevent
  rebinding when workspace history cannot be recovered.

## Guarantees

| Guarantee | Coverage |
| --- | --- |
| Offline project computers recover through the scheduler without another Start | API regression |
| Unavailable project executors recover through the same queue | API regression |
| Idle agent/project threads can start | API regression |
| Repeated starts do not produce duplicate commands | API regression |
| First admission persists the selected computer, without the temporary unbound marker | API regression |
| Actual task requests, session requests, and claims prevent re-routing | Unit regression |
| Executed legacy history without a recoverable computer stays protected | Workspace unit regression |

Focused validation: 49 passed with the following command:

```sh
PYTHONPATH=backend backend/.venv/bin/python -m pytest backend/tests/api/test_task_start_recovery.py backend/tests/unit/test_task_workspace.py backend/tests/unit/test_task_dispatch_lifecycle.py backend/tests/unit/test_blocked_execution.py -q --tb=short
```

## Full validation

- `npm test`: production web/TypeScript builds passed; 1,525 Node tests,
  80 React tests, and 1,622 Python tests passed. No skipped tests.
- Coverage run: 1,622 passed. The three changed modules have 88% combined
  statement coverage: node backend 88%, task dispatch 85%, task workspace 98%.

  ```sh
  uv run --project backend --with coverage --extra dev python -m coverage run --data-file=/tmp/relay-start-recovery.coverage --source=relay.services.task_dispatch,relay.services.task_workspace,relay.daemon_registry.node_backend -m pytest backend/tests -q
  uv run --project backend --with coverage --extra dev python -m coverage report --data-file=/tmp/relay-start-recovery.coverage --show-missing
  ```

- `npm audit --registry=https://registry.npmjs.org --json`: zero vulnerabilities.
- `git diff --check`: passed.
- Existing warnings concern Starlette TestClient, the PostgreSQL marker under
  the root pytest configuration, and SQLite's deprecated datetime adapter.

## Limits

Existing project tasks already stranded in backlog are not bulk-modified. A new
Start uses the corrected queuing behavior. No live agent runs were launched as
part of testing; tests exercise the real API, persistence, admission, and daemon
command queue using isolated databases and directories.
