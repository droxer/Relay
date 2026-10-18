# Separate Railway API and worker services

The user journey was derived from the request to show and operate the API and
background worker as different Railway services, using R2 for shared files.

## Red and green

- RED: `python3 deploy/tests/dockerfile.py` failed with `FileNotFoundError`
  for `deploy/services/worker.json`. The new test also requires `relay serve`
  for the API and a worker without an HTTP healthcheck or pre-deploy DDL.
  Checkpoint: `15c140d7`.
- GREEN: the same command passes after adding the worker profile and changing
  the API start command. `bash deploy/tests/run.sh` reports `all checks passed`.
  The mock suite needs localhost socket permission.

## Guarantees

| Behavior | Evidence | Result |
| --- | --- | --- |
| API and worker have separate profiles and one replica each | `deploy/tests/dockerfile.py`, `deploy/tests/run.sh` | PASS |
| API migrations and queue setup run before the worker deployment | Mock rejects a worker deployment until API success was observed | PASS |
| API, worker, and web release use the selected commit | Release assertions in both UI hosting modes | PASS |
| Worker uses API database, R2 credentials, and scheduler settings by reference | Initial provisioning and legacy-upgrade assertions | PASS |
| Worker has no public domain, HTTP healthcheck, or API listener variables | Worker profile and variable assertions | PASS |
| API failure preserves the previous worker deployment | Failed API release scenario | PASS |
| Worker failure prevents Cloudflare UI publication | Failed worker release scenario | PASS |
| Release creates a missing worker without another provisioning run | Legacy combined-service upgrade scenario | PASS |
| Repeated provisioning converges and region moves include the worker | Repeat-run and region scenarios | PASS |
| Missing or partial R2 configuration stops provisioning/release | Configuration failure scenarios | PASS |
| Pre-deploy commands preserve execution order and failure status | Stub executables in `deploy/tests/dockerfile.py` | PASS |

## Scope and limitations

These are shell integration tests against mock Railway and Cloudflare APIs.
No live deployment, R2 bucket creation, credential changes, or data migration
was performed. There is no instrumented shell coverage percentage. Runtime
process code and database schema are unchanged. Existing local skill files
must be migrated using the documented command before the first split release;
the scripts preserve existing volumes. GitHub automatic deployments remain
independent of the explicit release order.

The dependency audit was attempted; the configured registry could not be
resolved. No dependencies changed.

## Broader verification

- `npx tsc -p packages/tsconfig.json` and
  `npx tsc --noEmit -p web/tsconfig.json`: PASS.
- `npm run build -w web -- --webpack`: PASS, including the static export.
  `npm test` could not pass its default Turbopack build because its CSS worker
  was denied a local port, including on a permission retry.
- The direct Node test run reported 2,452 passes and three failures: two agent
  model discovery assertions and an agent detail routing source assertion.
  No files those assertions inspect changed in this task.
- React interaction suite: 565 passes, two timeouts. Both timed-out test files
  passed independently on retry (six tests).
- Full Python suite was stopped after 356 passes and two controlling-TTY
  installer test failures; remaining tests were not run.
- Focused background worker and process tests:
  `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest
  backend/tests/unit/test_background_worker.py
  backend/tests/unit/test_backend_processes.py -q`: 47 passed.
- `git diff --check`: PASS.
