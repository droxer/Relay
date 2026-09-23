# Team planning regression fixes

Journeys came from the review of team collaboration across threads and tasks.
The existing model retains one lead per team.

## Guarantees

| Journey | Regression coverage | Evidence |
| --- | --- | --- |
| Address the lead and a teammate, execute the lead's plan, then receive final synthesis | `test_addressed_lead_plan_runs_selected_work_then_synthesizes` in `backend/tests/api/test_team_routes.py` | Both empty and nonempty plans failed with `The plan needs an explicit result owner.` before the fix; both now finish successfully |
| Narrow addressing does not enlist an unaddressed required reviewer | Same HTTP/registry integration test | Only the addressed builder is offered to the lead; only selected work and final synthesis are dispatched |
| A single addressed lead remains a single turn | Same integration test's initial round | No planning candidates or extra command are generated |
| Omit optional specialists without leaving dangling dependencies | `test_replanned_manifest_dependencies_only_reference_selected_work` in `backend/tests/unit/test_collaboration_work.py` | Empty-plan dependencies were `lead, build, verify` instead of `lead`; now the graph contains only selected predecessors |
| Replanning preserves the original immutable roster | Same unit test, empty and nonempty variants | Original assignments remain unchanged |

The addressed-round fix adds the final lead assignment before admission. It
does not change recovery, discussion, or review dispatch. Work graph compilation
recalculates dependencies from the current roster while retaining captured
objectives, preserving idempotence when that roster has not changed. The graph
compiler is shared by thread and task rounds.

## RED and GREEN

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest \
  backend/tests/unit/test_collaboration_work.py \
  backend/tests/api/test_team_routes.py -q \
  -k 'replanned_manifest or addressed_lead_plan'
```

Before the fix: **3 failed, 1 passed**. After the fix: **4 passed**.
Checkpoints on the working branch: `92396626` (RED), `6c07c654` (GREEN).

The broader focused run of collaboration policy/service/work, team dispatch,
daemon registry, team API, task dispatch lifecycle, and task scheduler tests
passed **425 tests**.

`npm test` passed the production package/web builds and complete suites:
**1,692 TypeScript tests**, **283 React tests**, and **1,809 Python tests**.
`git diff --check` passed. No live-agent or browser run was needed for these
backend-only changes.

```sh
COVERAGE_FILE=/tmp/relay-collaboration.coverage UV_CACHE_DIR=.uv-cache \
  uv run --project backend --extra dev --with pytest-cov pytest \
  backend/tests/unit/test_collaboration_service.py \
  backend/tests/unit/test_collaboration_work.py \
  backend/tests/api/test_team_routes.py -q \
  --cov=relay.collaboration.service --cov=relay.collaboration.work \
  --cov-report=term-missing
```

Coverage run: **109 passed**, **87% combined statement coverage**
(`service.py`: 86%; `work.py`: 87%). This measures the two collaboration modules,
not the whole repository. Existing Starlette and SQLite reflection warnings
remain. The integration tests use real local stores and simulated daemon
completion events; they do not execute paid models or exercise browser UI.

Dependency audits made no changes: npm reported no vulnerabilities using the
public registry (the configured mirror does not implement audit). Python's
audit reported two advisories in the existing `anyio==4.13.0` dependency:
`CVE-2026-63374` and `CVE-2026-64847`, both listing `4.14.2` as the fixed version.
Dependency upgrades are outside these two collaboration fixes.
