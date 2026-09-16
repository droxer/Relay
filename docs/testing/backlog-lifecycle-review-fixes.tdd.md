# Backlog lifecycle review fixes

## Journeys and scope

Derived from the two review findings, without a separate source plan:

- Retrying a routine occurrence in Ready must dispatch when its previous sessions
  are terminal or missing, while retaining any live session.
- Starting an already-queued task must preserve its state even if its team or
  project assignment has become unavailable.

Changes are confined to backend dispatch and tests. No schema, daemon protocol,
authorization, or frontend changes are required. Execution remains on the daemon;
the existing claim/admission checks still fence duplicate execution.

## RED / GREEN

Command:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_task_dispatch_lifecycle.py backend/tests/api/test_team_routes.py -k 'routine_retry_dispatches or active_team_task' -q
```

- RED: 5 failed, 2 passed. Four inactive routine-session cases never dispatched;
  the queued team task was incorrectly rejected/blocked after disabling its team.
- GREEN: the same seven cases passed after the fix.
- RED checkpoint: `dc4e15ef`; GREEN checkpoint: `b8efa4ac`.
- Four additional unit cases verify that active claims and linked sessions prevent
  both project and team assignment resolution without mutating the task store.
  All nine lifecycle unit cases pass.

## Broader verification

- Dispatch unit and task/team API suites: 122 passed.
- Coverage command: `UV_CACHE_DIR=.uv-cache COVERAGE_FILE=/tmp/relay-lifecycle-review.coverage uv run --project backend --extra dev --with coverage coverage run --source=relay.services.task_dispatch -m pytest backend/tests/unit/test_task_dispatch_lifecycle.py backend/tests/unit/test_task_dispatch.py backend/tests/api/test_tasks.py backend/tests/api/test_team_routes.py -q`.
- Added `coverage run --append --source=relay.services.task_dispatch -m pytest backend/tests/api/test_project_routes.py -q` using the same environment: 21 passed.
- Combined dispatch module coverage: 81% (359 statements, 68 missed).
- `npm run test:py`: 1,502 passed, 5 skipped (PostgreSQL-dependent checks).
- `npx tsc -p packages/tsconfig.json`: passed.
- Compiled Node suites: 1,479 passed after an approved retry for sandbox process restrictions.
- `npm run test:react -w web`: 67 passed.
- `npm audit --registry=https://registry.npmjs.org`: no vulnerabilities.
- `uv run --project backend --with pip-audit pip-audit`: no known vulnerabilities;
  the local Relay package is not on PyPI and was skipped.

## Known verification limits

`npm test` stopped during the Next.js production build because Turbopack could not
bind a local port (`Operation not permitted`), including after an approval retry.
The suites were therefore run separately. No browser E2E run was performed for
these backend-only changes; HTTP integration tests cover the duplicate-start flow.
`git diff --check` passed.
