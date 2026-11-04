# Automation trigger boundary fixes

Journeys came from the automation trigger review: saving an automation must
preserve due work; resume must discard old deliveries; removing a schedule must
cancel its pending firing; fresh triggers must survive expiry of an older batch;
and run-event filters must describe the run when it completed.

## Regression evidence

The initial regression run executed 14 cases: **12 failed, 2 passed** before
production changes. The failures reproduced all five reported issues. The expiry
cases also asserted activity against the wrong projection; that assertion was
corrected to read `activity` after their primary firing assertions passed.

Two additional RED checks covered replacing schedules in pre-upgrade pending
rows, and an event arriving while resume waits for the automation lock. Each
failed before its corresponding compatibility/race fix, then passed.

The final boundary suite contains **20 passing cases**. The API suite also tests
both PATCH activation and POST resume against undrained webhook calls. A separate
migration test checks nullable backfill, preservation of existing counters, and
downgrade of the new cutoff column.

| Guarantee | Coverage |
| --- | --- |
| Unchanged daily and one-off schedules retain unprocessed slots. | `test_ordinary_form_save_keeps_unprocessed_due_slot` |
| Legacy schedule seeds survive v2 edits; completed one-offs stay exhausted. | `test_legacy_due_schedule_keeps_its_seed_on_v2_save`, `test_exhausted_once_stays_exhausted_on_ordinary_edit` |
| Resume rejects old webhook and broadcast deliveries, without consuming another recipient's broadcast. | `test_resume_ignores_undrained_events_but_keeps_other_recipients` |
| Resume records its cutoff after acquiring the automation lock. | `test_resume_cutoff_is_recorded_after_waiting_for_automation_lock` |
| Removing or changing a schedule invalidates its pending event, including pre-upgrade rows. | `test_pending_schedule_is_invalidated_when_its_trigger_changes`, `test_legacy_pending_schedule_is_invalidated_by_replacement` |
| Adding unrelated triggers or retaining a sibling due at the same slot preserves eligible pending work. | `test_pending_schedule_survives_adding_an_unrelated_trigger`, `test_shared_schedule_slot_survives_removing_one_source` |
| Fresh schedule, manual, and webhook events survive expiry of an old batch, with a drop recorded. | `test_expired_pending_batch_does_not_discard_a_fresh_trigger` |
| Later priority/title edits cannot alter run-event matching; unlinking cannot erase loop provenance. | `test_run_event_filters_use_completion_snapshot`, `test_run_completion_keeps_provenance_after_unlinking_task` |
| Both resume API paths drop old calls and accept fresh calls. | `test_resume_drops_undrained_webhook_calls` |
| The new migration preserves existing state and downgrades. | `test_resume_cutoff_migration_preserves_existing_state` |

## Validation

```sh
uv run --project backend --extra dev --with pytest-cov pytest \
  backend/tests/unit/test_automation*.py backend/tests/api/test_automation*.py \
  --cov=relay.automations --cov=relay.persistence.automation \
  --cov-report=term-missing -q
```

Result: **275 passed**, **93% statement coverage** across the automation domain
and automation persistence modules. Lint (`ruff check backend`), mypy (401 source
files), and `git diff --check` passed. Layering and module-size checks passed in
the focused structural run (27 tests including regression and migration cases).
Alembic reports one head, `20261104_0110`.

The full Python run (`uv run --project backend --extra dev pytest -q`) passed
**3,468 tests**, with **10 skipped**, in 586.52 seconds. That run started before
the final compatibility/race refinements and four additional regression cases;
the subsequent focused 275-test run covers the final implementation and all
added cases. The final structural check separately passed all eight layering
and module-size cases.

The production Next.js build and TypeScript compilation passed. The full Node
suite reported **2,910 passed / 4 failed**: a daemon update-poll timing test
(passed when rerun alone), plus existing source assertions for palette
breakpoints, transcript recovery operation ids, and persisted board views. No
TypeScript source changed. The separately run React suite passed **775 tests**
across 132 files. `npm audit --omit=dev --audit-level=high` against the public npm
registry reported zero vulnerabilities; the configured mirror lacks an audit
endpoint. No dependency files changed.

A full SQLite migration-chain smoke test stopped at the existing initial
Postgres-only `CREATE EXTENSION pgcrypto`; the isolated new migration's SQLite
upgrade/downgrade test passed. Live PostgreSQL migration and concurrency results
used a temporary UTF-8 PostgreSQL 17 instance on an ephemeral loopback port,
stopped and deleted after validation:

```sh
RELAY_TEST_DATABASE_URL=<temporary-local-database> uv run --project backend --extra dev pytest \
  backend/tests/unit/test_schema_drift.py \
  -k 'migrated_schema_matches_declared_metadata or automation_matchers or automation_migrations' -q
```

All four automation cases passed (three concurrency cases and the legacy
migration case). The metadata comparison failed only on five existing daemon
indexes: `ix_daemon_commands_terminal_retention`,
`ix_daemon_run_requests_current_command`, `ix_daemon_run_requests_recovery`,
`ix_daemon_run_requests_terminal_retention`, and
`ix_daemon_runs_terminal_retention`. There was no automation schema drift.
A separate scratch PostgreSQL run upgraded the full chain to head, downgraded
the cutoff migration, and re-upgraded it, verifying nullable initialization and
preservation of existing firing/failure counters throughout.

## Implementation and rollout

Apply migration `20261104_0110` before starting the updated backend. It adds the
nullable `automation_state.events_after` cutoff; existing rows are unchanged
until resumed. Pending clearing and counter resets preserve that cutoff.

New run-event outbox rows capture matching facts and loop provenance inside the
completion transaction. Older undrained run-event rows retain legacy enrichment:
their historical matching facts cannot be recovered from a mutable snapshot.
Old pending schedule rows use their generated summary to identify a source;
new rows retain every source schedule sharing the due slot.

The RED checkpoint is `d9fa738c` on this branch. The fix checkpoint carries the
production changes, additional regression cases, migration, and this evidence.
No remote resources were modified and nothing was pushed.
