# Team repair and lead coordination regression fixes

Journeys were derived from the follow-up agent-team collaboration review.
They extend [the planning regressions](team-planning-regressions.tdd.md).

| Guarantee | Regression | RED evidence | GREEN evidence |
| --- | --- | --- | --- |
| A coordinator repair invalidates previous acceptance and restarts member work | `test_coordinator_repair_discards_stale_evidence_and_restarts_member_work` | Old build and verification reports remained accepted | Reports, aggregate verdict, old failure blockers, and interrupted consultation routing are cleared without mutating the input state |
| A repaired task requires fresh verification | `test_coordinator_repair_revalidates_all_work_before_task_acceptance` | Previously accepted reports survived the repair | Builder and verifier rerun; fresh blocked verification parks the task at `waiting_for_human` |
| Both daemon failure envelopes apply bounded coordinator repair | Same registry integration test, `run.completed` and `run.failed` parameters | `run.failed` produced no repair command | Both envelopes run coordinator repair and subsequent revalidation |
| Mention order cannot bypass the addressed lead | `test_addressed_lead_plan_runs_selected_work_then_synthesizes` | Builder-first addressing ran the builder before the lead | Both address orders dispatch the lead first and complete empty/nonempty plans through synthesis |

Existing focused tests also cover repair-budget exhaustion, a failing lead,
taskless rooms, non-team pipelines, semantic repair, and teammate consultations.
Repair/consultation counters, cancellation fences, authority checks, and frozen
assignment identities are preserved. A coordinator repair conservatively reruns
the member sequence because the coordinator can modify the shared workspace.
Historical evidence remains in the event log; it cannot certify the new work.

## Validation

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest \
  backend/tests/unit/test_collaboration_policy.py \
  backend/tests/unit/test_daemon_registry.py \
  backend/tests/api/test_team_routes.py -q \
  -k 'coordinator_repair_discards or coordinator_repair_revalidates or addressed_lead_plan'
```

Before the fix: **7 failed, 2 passed** (`2c6c4b4c`, RED checkpoint).
After the fix: **9 passed** (`07eeed86`, GREEN checkpoint).

```sh
COVERAGE_FILE=/tmp/relay-repair.coverage UV_CACHE_DIR=.uv-cache \
  uv run --project backend --extra dev --with pytest-cov pytest \
  backend/tests/unit/test_collaboration_work.py \
  backend/tests/unit/test_collaboration_service.py \
  backend/tests/unit/test_collaboration_policy.py \
  backend/tests/unit/test_team_dispatch.py \
  backend/tests/unit/test_daemon_registry.py \
  backend/tests/api/test_team_routes.py \
  backend/tests/unit/test_task_dispatch_lifecycle.py \
  backend/tests/unit/test_task_scheduler.py -q \
  --cov=relay.collaboration.service --cov=relay.collaboration.policy \
  --cov=relay.collaboration.work --cov-report=term-missing
```

Result: **432 passed**; **88%** combined statement coverage (`policy.py`: 98%,
`service.py`: 87%, `work.py`: 89%). This is scoped module coverage, not whole-repo
coverage. Existing Starlette and SQLite reflection warnings remain.

`npm test` passed the production package/web builds and all **1,692 TypeScript**,
**283 React**, and **1,816 Python** tests. `git diff --check` also passed.

These tests use real local stores and simulated daemon events. No paid models
or live browser interactions were run. Dependency audits made no changes: npm
reported zero vulnerabilities; pip-audit reported the same two existing AnyIO
advisories documented in the preceding planning validation.
