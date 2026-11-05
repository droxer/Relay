# Python CI fixture evidence

Source: PR #658's Python job reported six failures, 3,566 passes and three skips.
The SQLAlchemy reflection and SQLite datetime messages were warnings, not the
cause of these failures. No warning filters or test skips are added.

## Reproductions and fixes

| Failure | RED evidence | Change and guarantee |
| --- | --- | --- |
| Active team task start | The existing two-case target reproduces one pass and one failure (`queued` versus `rejected`). | Expect the dispatcher's existing `queued/task_execution_active` response for both admitted and executing work. Keep assertions that status is unchanged and no second command is leased. |
| Container/build-context paths | Both structure tests fail when invoked from `backend/`. | Resolve inputs from `Path(__file__).resolve().parents[3]`; the same tests pass from either working directory. |
| PostgreSQL worker migration/service tests | Both targets reproduce `fe_sendauth: no password supplied` against an isolated password-protected PostgreSQL 16 container. | Preserve `params.get("password")` in both reconstructed SQLAlchemy URLs; retain schema, options, host, port, database and user. |
| Cold-runner liveness throttle | RED checkpoint `46ff9769` adds 100-second and 7,200-second uptime cases. Cold uptime fails with zero rather than one lock acquisition. | Age the recorded observation by the configured interval rather than setting it to zero. Both uptime cases retain the exact dispatch-lock acquisition assertions. |

These are test-fixture and expected-result changes. Backend runtime behavior,
authentication policy, database migrations, and the CI service configuration
remain unchanged. Tests connect only to the disposable test database.

## GREEN verification

From `backend/`, with `RELAY_TEST_DATABASE_URL` set to the disposable PostgreSQL
16 database using the same username/password contract as CI:

```sh
uv run pytest -q \
  tests/api/test_team_routes.py::test_start_on_an_active_team_task_leaves_its_status_alone \
  tests/unit/test_backend_structure.py \
  tests/unit/test_background_worker_postgres.py \
  tests/unit/test_latency_regressions.py
```

Result: **32 passed** in 19.88 seconds. This covers all six reported failures and
both host-uptime cases. The two path tests also pass when invoked from the repo
root. All 17 pre-commit hooks and `git diff --check` pass.

The complete Python suite runs separately against the disposable PostgreSQL
database; its final result and the GitHub verification are recorded in the PR.
No new runtime code is introduced, so production coverage is unaffected.
The RED checkpoint and the fix commit containing this report preserve the
regression evidence if the PR is later squash-merged.
