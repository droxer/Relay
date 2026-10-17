# Procrastinate integration evidence

Journeys were derived from the implementation discussion: an operator can run
periodic control-plane work independently of HTTP serving; moving consumers
does not disable automation event production; restarting or duplicating
workers does not discard pending checks or overlap normal domain checks.

## RED and GREEN

- Initial RED: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev
  pytest backend/tests/unit/test_background_worker.py -q` failed collection
  with `ModuleNotFoundError: No module named 'relay.background'`, the missing
  implementation under test. Recorded in checkpoint `89a39678`.
- PostgreSQL recovery RED: the first real-database run had 3 passes and 1
  failure. Requeueing a stalled check conflicted with a pending check's
  `procrastinate_jobs_queueing_lock_idx_v1`. Recovery now records the old
  control check failed and allows the next durable scan to run.
- Recovery race RED: the deleted-job case raised `NoResult` when the original
  worker finished and deleted the check during recovery. Recovery now accepts
  this terminal race while still surfacing database errors for active jobs.

## Verified guarantees

| Guarantee | Test | Result |
| --- | --- | --- |
| External API mode preserves automation production and starts no periodic consumers | `test_background_worker.py::test_external_api_keeps_automation_events_without_starting_consumers` | PASS |
| Embedded API mode retains service startup and shutdown | `test_background_worker.py::test_embedded_api_still_starts_and_stops_services` | PASS |
| Worker URL conversion preserves escaped credentials, SSL, and connection options | `test_background_worker.py::test_worker_conninfo_preserves_credentials_and_connection_options` | PASS |
| Unsupported storage and cron intervals fail early | Parameterized tests in `test_background_worker.py` | PASS |
| Real Procrastinate worker invokes existing domain services | `test_background_worker.py::test_jobs_invoke_existing_services_through_a_real_procrastinate_worker` | PASS |
| Cancellation waits for outstanding synchronous store work | `test_background_worker.py::test_cancelled_job_waits_for_database_work_to_finish` | PASS |
| CLI worker commands do not start an HTTP server | `test_cli.py::test_worker_commands_do_not_start_an_http_server` | PASS |
| Successful work disappears and failures remain inspectable | Worker tests using Procrastinate's test connector | PASS |
| Persisted jobs survive producer teardown and another app processes them | `test_background_worker_postgres.py::test_jobs_survive_a_producer_restart_and_are_processed_once` | PASS |
| Periodic schedule deferrals deduplicate across instances | `test_background_worker_postgres.py::test_periodic_schedules_deduplicate_across_worker_instances` | PASS |
| Domain execution locks serialize competing workers | `test_background_worker_postgres.py::test_execution_lock_serializes_jobs_across_workers` | PASS |
| A stalled check plus a pending check cannot block recovery | `test_background_worker_postgres.py::test_stalled_tick_with_a_pending_tick_cannot_block_recovery` | PASS |
| Vendor schema installation is idempotent | `test_background_worker_postgres.py::test_schema_installer_is_idempotent_on_postgres` | PASS |
| Alembic autogeneration preserves installed vendor tables | `test_background_worker_postgres.py::test_alembic_autogeneration_preserves_vendor_schema` | PASS |
| Existing services execute against a fully Alembic-migrated database | `test_background_worker_postgres.py::test_worker_processes_real_relay_services` | PASS |

## Commands and coverage

```bash
UV_CACHE_DIR=.uv-cache uv run --offline --project backend --extra dev --with pytest-cov pytest backend/tests/unit/test_background_worker.py backend/tests/unit/test_cli.py --cov=relay.background --cov-report=term-missing -q
```

Result: **38 passed**, new background module **100% statement coverage**
(106 statements). The integration tests use a temporary local PostgreSQL 17
cluster and disposable schemas, selected by `RELAY_TEST_DATABASE_URL`:

```bash
UV_CACHE_DIR=.uv-cache uv run --offline --project backend --extra dev pytest backend/tests/unit/test_background_worker_postgres.py -q
```

Result with the test URL set: **7 passed**. Without an explicitly supplied
test database URL these PostgreSQL tests skip; they never target production.

```bash
UV_CACHE_DIR=.uv-cache uv run --offline --project backend --extra dev pytest backend/tests/unit/test_task_scheduler.py backend/tests/unit/test_notifications.py backend/tests/unit/test_cli.py -q
```

Result before adding the two new CLI cases: **51 passed**.
`uv lock --offline --project backend --locked`, `git diff --check`, and
`make -n backend-worker backend-worker-schema` also passed.

Final full backend run, after all production edits were complete:

```bash
UV_CACHE_DIR=.uv-cache uv run --offline --project backend --extra dev --with pytest-xdist pytest backend/tests -n 4 -q --tb=short
```

Result: **3052 passed, 8 skipped** in 206.12 seconds, using local permissions
for installer terminal tests. Seven skips are the new worker PostgreSQL
tests, which require an explicitly supplied test URL and passed separately
against the temporary cluster. The other skip is an existing optional test.

## Boundaries and known gaps

- Domain services and their event transactions remain authoritative. The
  worker does not execute agents or release daemon reservations based on its
  own heartbeat. Agent-dispatch failures retain the manual-retry policy.
- Queue delivery is at least once. Normal execution locking does not fence a
  process that resumes after heartbeat loss; domain-level claims remain
  necessary. Tests cover durable state and coordination, not an exactly-once
  guarantee.
- No browser surface changed. No browser tests are added.
- Durable email jobs and a worker monitoring UI are outside this first
  integration. Existing email callbacks and token handling are preserved.
- Dependency audit ran before both checkpoint stages. It reported existing
  advisories in unchanged `anyio==4.13.0` and `virtualenv==21.4.3`; it reported
  no advisory for the added Procrastinate dependencies. These pre-existing
  dependency updates are not included in this change.
- An initial full-suite run was interrupted after **505 passed and 2 failed**:
  both failures were installer tests denied `/dev/tty` by the sandbox. The
  suite was restarted with local permissions and four test processes. That
  run had **3027 passed, 7 skipped, 21 setup errors** because the Alembic
  filter was added while the processes still held the old schema module.
  All 21 migration cases passed in a fresh-process rerun; the final complete
  run above then passed against the finished implementation.
