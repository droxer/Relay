# Backend review fixes

The user requested fixes for seven issues reproduced during the whole-backend
review. The journeys are derived from that review: protect a personal
computer's credentials and enrollment limits, keep draining and cleared
configuration authoritative across replicas, accept streamed output once,
and reconcile only an execution that still qualifies for recovery.

## RED evidence

```sh
backend/.venv/bin/pytest backend/tests/api/test_backend_credential_regressions.py backend/tests/unit/test_backend_replica_regressions.py -q
```

Before production changes: **11 failed, 1 passed**. The failures reproduced all
seven defects; the passing case confirmed that adopting an existing computer
at its limit must remain possible. Checkpoint: `7e46fc68`.

Two additional interleavings were tested after the first fix: a poll racing
the drain write, and a setting cleared after registration's initial read.
Both failed before their SQL guards were added (**2 failed, 10 passed**).
Injected output and reconciliation write failures also verify rollback.

## Guarantees

| Guarantee | Regression test | Type |
| --- | --- | --- |
| Admin lists omit personal-computer launch credentials | `test_admin_list_never_discloses_personal_computer_launch_token` | API |
| Only the owner rotates a personal computer's credential; denied rotation keeps the old credential valid | `test_only_owner_can_rotate_personal_computer_credential` | API |
| Legacy sandbox creation obeys the quota, while adoption remains allowed | `test_legacy_sandbox_creation_obeys_personal_computer_limit`, `test_legacy_existing_sandbox_can_be_adopted_at_limit` | API |
| A warm replica and a racing poll cannot lift a drain; registration resumes delivery | `test_warm_replica_never_delivers_work_after_drain`, `test_poll_cannot_overwrite_a_concurrent_drain` | Database integration |
| Registration preserves cleared runtime settings, including a clear after its initial read | `test_registration_on_warm_replica_cannot_restore_cleared_setting`, `test_registration_preserves_setting_cleared_after_its_initial_read` | Database integration |
| Single output, batches, and collaboration events deduplicate across warm replicas | `test_streamed_event_retries_are_deduplicated_across_warm_replicas` | Database integration |
| Failed output writes roll back both the event and cursor; retry is accepted once | `test_failed_stream_write_does_not_consume_its_durable_cursor` | Fault injection |
| Reconciliation preserves a replacement execution and rolls back an assertion if cancellation fails | `test_reconciliation_cannot_release_a_newer_execution`, `test_reconciliation_rolls_back_its_assertion_when_command_write_fails` | Database integration / fault injection |

API tests live in `backend/tests/api/test_backend_credential_regressions.py`;
replica and rollback tests live in
`backend/tests/unit/test_backend_replica_regressions.py`.

## Implementation and compatibility

Personal enrollment routes share a per-user database resource lock and refresh
the durable node view before counting. Adoption does not consume another slot.
The existing computer-management authorization rule guards token rotation.

Poll updates preserve the drain sentinel in SQL, and command leasing checks
it while holding the node row lock. Node refresh replaces durable optional
settings while retaining local inventory, and registration preserves the
latest settings under its database row lock.

Stream cursors are internal command metadata (`_outputSequences`), committed
in the same transaction as their thread events. Older commands seed their
cursor from retained events. The field is excluded from daemon command
payloads. Reconciliation rechecks eligibility under the thread row lock used
by admission and commits its assertion and cancellation together. No schema
migration or daemon protocol change is required.

Existing tests that expected an admin list to expose a personal token now
expect redaction. Read-only authentication and managed-node fixtures persist
their setup before checking refreshed state. The restart-deduplication test
now proves that durable cursors avoid rescanning output history.

## Validation

- Focused regressions: **16 passed** on SQLite.
- The same regressions with `RELAY_TEST_STORE_BACKEND=postgres` and
  `RELAY_TEST_DATABASE_URL` pointing at local PostgreSQL: **16 passed** in
  disposable schemas.
- Affected API and lifecycle suites: **139 passed**.
- Expanded registry, execution, and API coverage run: **324 passed**.
- Standard-library tracing measured **148/163 changed executable lines
  (90.8%)** across the production changes, including the new cursor module.
  This is scoped line coverage, not repository-wide or branch coverage.
  The optional `coverage` package could not be resolved by the registry.
- Ruff and mypy pass; mypy checks **385 source files**.
- `npm run test:ts`: production package/web builds succeeded; **2,854 Node
  tests** and **739 React tests** passed.
- Full backend suite: **3,353 passed, 10 skipped** in 562.23 seconds. The
  skipped tests retain their existing environment requirements.

The first sandboxed full run could not exercise three installer tests that
need a controlling terminal; the final full run uses the required permissions.
The npm dependency audit reported **34 existing advisories** (1 low,
25 moderate, 7 high, 1 critical). Dependency upgrades are outside this change.
`pip-audit` was unavailable and could not be resolved by the registry, so no
successful Python advisory audit is claimed.

The RED checkpoint and this report preserve the failure evidence. The fix
checkpoint records the final GREEN checks. No dependency manifests changed.
