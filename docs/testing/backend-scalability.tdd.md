# Backend scalability TDD evidence

The work follows the five findings from the backend scalability review. No external plan file was used.

| User guarantee | Regression coverage |
| --- | --- |
| Starting/picking up tasks does not run synchronous authentication on the application event loop | `test_scalability_fixes.py::test_task_dispatch_auth_does_not_run_on_event_loop` |
| Streaming does not resend completed logs in snapshot writes; full details still contain the logs | `test_stream_writes_exclude_old_logs_but_details_preserve_them` |
| Reconnect event-ID lookup uses an index | `test_reconnect_cursor_has_index`, PostgreSQL schema-drift checks |
| Replicas share managed capacity, grants and images; concurrent provisioning has one winner | `test_managed_state_and_images_are_shared_between_replicas`, `test_managed_attempt_creation_is_atomic_across_instances` |
| Imports preserve local records and credentials, support dry-run, and do not overwrite later database edits | `test_local_operational_import_is_dry_runnable_and_idempotent` |
| Recovery is paged, does not acquire the fleet dispatch lock for scanning, and distributes claims across replicas | `test_recovery_queries_are_bounded_in_sql`, `test_recovery_does_not_acquire_fleet_dispatch_lock`, PostgreSQL disjoint-page and lease-expiry test |
| Retention caps deletion work and avoids loading command payloads | `test_retention_limits_deletes_and_does_not_load_command_payloads`, existing terminal-retention tests |
| Different managed nodes can mutate concurrently, and enrollment runtime identity remains fenced | `test_schema_drift.py::test_postgres_managed_nodes_lock_independently_and_enrollment_is_shared` |

## RED

`uv run --project backend --extra dev pytest backend/tests/unit/test_scalability_fixes.py -q`

Six initial failures reproduced the missing worker boundary, large snapshot write, missing cursor index, missing shared operational stores, and missing bounded recovery query interface. The checkpoint is commit `40b27ab1` on the working branch. The first endpoint test invocation was corrected to use the existing signature before capturing the RED checkpoint.

## GREEN and integration checks

- The expanded scalability regression file passed: **19 tests**.
- PostgreSQL migrations through `0077`, schema comparison, WIP concurrency, and the new cross-replica tests passed: **10 tests**. Command: `RELAY_TEST_DATABASE_URL=<disposable PostgreSQL URL> uv run --project backend --extra dev pytest backend/tests/unit/test_schema_drift.py -q`.
- Focused finalization retry, grouped-query, and retention regressions passed: **8 tests**.
- The first broad backend run found four regressions (test instrumentation pagination arguments and explicit retry eligibility); those were corrected and the focused tests rerun.

Final validation:

- `npm test` completed the production builds, **1,525 TypeScript/Node tests**, and **80 React tests** successfully. Its first Python phase found the four regressions described above.
- After the fixes, `uv run --project backend --extra dev --with pytest-cov pytest backend/tests -q --cov=backend/relay --cov-report=json:<report-path> --cov-report=term:skip-covered` passed **1,607 tests**, with **88% backend statement coverage**.
- Additional validation/rollback and worker-boundary tests added during the coverage run passed in the final **19-test** scalability target. The final PostgreSQL target passed **10 tests**, including a migration downgrade/upgrade roundtrip and a real reconnect cursor read.
- Focused coverage of the four new/shared-storage modules passed **59 tests** and reported **93% statement coverage** (managed store 92%, operational import 96%, profile images 93%, resource locks 90%). PostgreSQL-specific lock behavior is additionally covered by the separate real-database tests.
- `git diff --check` and focused Ruff undefined/unused-name checks passed.

These checks verify correctness and bounded work, not deployment throughput or latency capacity. Coverage is statement coverage; no throughput capacity claim or full branch-coverage claim is made.

## Dependencies

`pip-audit` found no known vulnerabilities in resolved dependencies (the local Relay package is not on PyPI). The configured npm mirror has no audit endpoint; retrying `npm audit --registry=https://registry.npmjs.org --audit-level=critical` succeeded.
