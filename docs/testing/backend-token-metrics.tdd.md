# Grouped dashboard token metrics

Journeys were derived from source inspection during the backend refactor, without
an external plan. An administrator needs complete token totals and missing-usage
notices without downloading every matching run or its private task-goal text.
A timezone choice must preserve local calendar days, including daylight-saving
transitions. Retained usage must remain visible after thread deletion, and
non-dashboard ledger readers must keep their complete records.

## Implementation

`persistence/session/metrics.py::SessionMetricRows` owns dashboard session and
token metrics, assembled into `DatabaseSessionStore` alongside its other focused
mixins. Token reporting performs one grouped ledger query. Reported usage shares
a daily group; unreported usage groups by day/runtime. At most
`(day_window + 1) * (1 + distinct unreported runtimes)` rows are transferred,
rather than one per run. The query neither joins sessions nor selects IDs,
task-goal text, or other run metadata. It uses the existing completion-time index
predicate and requires no schema migration.

Python calculates each local midnight's UTC boundary; SQL classifies timestamps
against those bounds. This preserves 23/25-hour days on both supported database
dialects without timezone extensions. Summary-only future observations retain
the previous reporting behavior. Missing-run counts are ordered by count then
latest observation, with a deterministic runtime-name tiebreaker at identical
timestamps. Aggregation uses normalized cache-read/write ledger columns, while
existing event normalization continues to handle legacy combined-cache counts.

The route now asks the explicit store protocol for the projection and retains
its authorization, timezone fallback, response shape, and per-window cache. The
retired raw `list_dashboard_token_usage` reader and route-side aggregation were
removed. `list_token_usage` still returns the entire retained ledger with its
metadata; it is not silently replaced by summaries.

## RED and GREEN evidence

- `e0283d6a`: six store regressions failed because grouped metrics were missing.
  The initial API reproducer also failed, but its first failure was a fixture
  missing the explicit token total required by the event contract.
- `d081487c`: corrected that fixture, reran the original route from the committed
  baseline, and verified the intended RED assertion: it selected task-goal
  metadata and lacked a grouped query. The temporary baseline route was restored
  to the working implementation in a `finally` block.
- `3de35980`: the same store/API target passed **20 tests** on SQLite and
  **19 relevant tests** on PostgreSQL (one unrelated SQLite-specific notification
  expectation deselected).
- `34db31aa`: moved existing session counters into the metrics mixin, removed
  the retired raw dashboard reader, and expanded regression coverage. The
  broader target passed **98 tests**, with one PostgreSQL-only case skipped
  before enabling a PostgreSQL test URL.

## Guarantees

| Guarantee | Test evidence | Type |
| --- | --- | --- |
| Transfer grows with groups, not runs | 1,230 ledger rows produce exactly two SQL result rows, one statement, no metadata fields or session join | Database/work-bound |
| Both daylight-saving transitions preserve local dates | Exact midnight, one microsecond before/after, 23-hour spring day, 25-hour autumn day, and UTC+14 zone | SQLite/PostgreSQL regression |
| Reporting windows remain complete | Exact fourteen-/seven-day cutoffs, future observations, old usage, and custom window sizes | Database regression |
| Unreported usage does not inflate totals | Missing counts merge across days, exclude unnamed runtimes, and preserve count/recency ordering | Database regression |
| Deleted-thread history and full records survive | Ledger rows refer to absent sessions; grouped totals and all 1,230 full metadata records remain available | Database integration |
| Empty/invalid requests behave predictably | Fourteen zero buckets for empty storage; invalid internal window combinations raise before querying | Unit/database |
| API uses grouped storage | Real authenticated request selects grouped ledger columns, without task-goal metadata | HTTP integration |
| Existing dashboard behavior remains | Cache, fresh/cache split, legacy cache normalization, timezone fallback, auth, and session-metrics tests | API/architecture integration |

## Validation

Commands use `uv run --project backend --extra dev`:

```sh
pytest backend/tests/unit/test_dashboard_token_metrics.py backend/tests/api/test_dashboard.py -q
pytest backend/tests/unit/test_dashboard_token_metrics.py backend/tests/api/test_dashboard.py backend/tests/api/test_request_latency.py backend/tests/unit/test_schema_scalability.py backend/tests/unit/test_session_store.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py -q
```

The latter coverage run used `--with coverage coverage run` with
`--source=relay.persistence.session.metrics,relay.api.admin.dashboard` and measured
**100% statement coverage** of both modules (94 executable statements). This is
not a branch-coverage claim. Ruff passed; mypy reported zero errors in **448
runtime files**. `pip-audit --local` found no known vulnerabilities.

The final PostgreSQL-backed target passed **55 tests**, with the unrelated
SQLite-only notification expectation deselected. The same test runs normally in
the canonical full suite. Client validation (`npm run test:ts`) passed production
builds, **2,956 Node tests**, and **833 React tests**. Final full-backend results
completed with **3,798 passed** in 438.05 seconds. The command was
`RELAY_TEST_DATABASE_URL=<disposable PostgreSQL URL> uv run --project backend --extra dev pytest backend/tests -q`;
no tests were skipped. `git diff --check` passed. The disposable database was
used only for tests and was stopped/removed after all test processes finished.

## Limits and remaining scope

The database still aggregates every ledger row in the indexed reporting window;
this change bounds transferred data and Python materialization, not database CPU
or production p95 latency. Unreported grouping depends on distinct runtime names.
The old summary treatment of future-dated usage is preserved explicitly; changing
it would be a separate contract decision. No provider or daemon protocol changes
are required. The [automation discovery follow-up](backend-automation-discovery.tdd.md) addresses
the next identified tick-discovery issue. Full-history API response sizes and
representative deployment-load measurements remain part of the active backend
refactoring goal.
