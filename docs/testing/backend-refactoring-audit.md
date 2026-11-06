# Backend refactoring completion audit

Objective: “refactor and reorganize the backend as python best practice according
software design principal including performance, scalibiltiy”.

This audit evaluates the current backend, rather than treating individual green
refactor checkpoints as completion. The acceptance criteria below derive from
that objective and the repository's explicit architecture, safety, migration,
and verification invariants. The future product roadmap is not part of this
refactoring request; production deployment and a supported capacity/SLA are not
claimed by local tests.

## Requirements and authoritative evidence

| Requirement | Current implementation and evidence | Audit disposition |
| --- | --- | --- |
| Python owns the control-plane runtime | Root `backend/pyproject.toml`, `relay.cli:main`, `app.py`/`bootstrap`, and domain packages. A fresh wheel built from its sdist contains all 449 runtime Python modules and the CLI entry point; benchmark fixtures are excluded. | Verified |
| Cohesive modules and one-way dependencies | `test_layering.py` inspects the import graph for cycles, upward and deferred imports, pure-policy imports, and empty package initializers. `test_module_size.py` has empty over-budget allowlists. The current inventory is 449 modules / 69,124 lines; largest module 767 lines, largest package's own modules 4,460 lines, below the 800/5,000 limits. | Verified |
| Explicit wiring and testable ownership | `app.py` builds stores/runtime/context; `api/deps.py` is the request-state seam. `test_api_state_access.py` enforces that API modules use that seam. Persistence owns storage; pure domain policies are explicitly listed and checked by the layering test. No generic service/common/utility package was introduced. | Verified |
| Validated Python boundaries and predictable failure modes | Central `AppSettings` startup validation, bounded body/schema helpers, actor/account distinction, parameterized storage access, and environment-backed credentials. Ruff checks blind exception handling and mypy checks 449 runtime modules with Python 3.12 as its target. Settings, auth, invalid-ID, access, and rollback tests exercise errors as well as success. | Verified |
| Synchronous I/O stays out of active async request paths | HTTP thread-placement tests, scheduler worker/shutdown tests, `test_chat_async_io.py`, and the async refactoring report cover the affected call chains. A refreshed direct-call AST screen found a pure heartbeat-settings read and three native async provider guards; their implementations were inspected. The two native database-call candidates use psycopg `AsyncConnection`. The screen is supporting evidence, not a substitute for call-chain tests. | Verified for the audited runtime paths |
| Hot reads scope and limit work before materialization | Ownership filters precede full-history hydration; history ID binds batch at 500. Summary endpoints cap selected rows. Artifact projections avoid event-log hydration. Token metrics transfer SQL groups; public chat metadata avoids credential decryption and selected/runtime reads decrypt only selected/active rows. Adversarial work-bound, query-plan, API completeness, and PostgreSQL tests cover these contracts. | Verified |
| Streaming and mutations avoid history write amplification | Stream-neutral events append without rewriting snapshots or indexing the version/liveness write columns. Completed logs remain in authoritative events; details hydrate them. Task writes apply new events to projections. Durable output cursors deduplicate event retries with the event write in one transaction. Performance, reducer-isolation, replica, and failure-injection tests cover the behavior. | Verified |
| Background work is bounded and can progress | Task scheduling uses keyset candidate pages and a dispatch budget. Recovery/retention use bounded claims/deletes and durable leases. Automation discovery claims B rows, visits B listener projections, and selects B candidate IDs, with at most 3B distinct routines processed. Persisted cursors and failure/rollback tests establish progress without dropping recipients. | Verified |
| Replicas coordinate through durable state | Shared SQL stores, per-user admission and per-resource mutation locks, conditional leases, provider-operation guards, and durable routing/output cursors replace unsafe process-local authority. PostgreSQL tests use distinct stores/connections and controlled interleavings for WIP admission, independent users/nodes, recovery claims, chat writers, and automation firing. These are database concurrency tests, not a multi-host capacity benchmark. | Verified within the tested consistency contracts |
| Connections, cancellation, and caches have lifecycles | Bounded pools/timeouts, transaction joins on one worker thread, after-commit callbacks, native async guard cleanup, and supervised loop shutdown. Pool-size-one tests establish read progress. Dashboard caches bound completed entries, share builds, expire from completion, release failures, invalidate in-flight publication, and weakly retain stores. Probe phases end without checked-out connection leaks. | Verified |
| Authorization and execution safety remain intact | Real route-table tests check anonymous refusal and require 403 for every admin route to a signed-in non-admin; domain tests cover ownership and personal-computer credential protection. The API router groups apply the admin dependency centrally. Execution remains daemon-command based. Reconciliation/deletion record human assertions and recovery tests preserve delivered reservations without exit evidence. Encrypted chat credential and migration tests verify redaction and rollback. | Verified by source and behavior tests; not a claim of exhaustive security assurance |
| Schema changes have rollout and rollback paths | Tables remain declared once, Alembic head is 0119, and real PostgreSQL schema-drift/round-trip tests pass. Large indexes build concurrently and repair invalid leftovers. Legacy conversion is transactional/fail-closed. Downgrade rejects partially routed broadcasts before changing indexes/progress; encrypted credential rollback requires its existing key. The rollout ordering is documented. | Verified; production migration not performed |
| Performance/scalability improvements have measurements | Work-bound regressions establish concrete reductions; the new manual probe exercises real migrated PostgreSQL stores and authenticated ASGI routes with small/larger fixtures, constrained/default pools, and concurrent automation ticks. Raw measurements and methodology are linked below. | Verified; all 1,350 requests returned 200 and all 1,100 routine checks found one occurrence |
| Required build/static/test gates remain green | Python sdist/wheel build; Ruff; mypy; Python dependency advisory audit; complete backend suite including PostgreSQL checks; client production builds and suites; final whole-backend coverage run. | Verified: 3,811 backend tests passed; 91.88% statement coverage |

## Verification scope

Runtime/migration trees are byte-for-byte unchanged from `a2e5ba9c`, the source
state whose complete suite passed **3,811 tests**. `eb846e79` added the phase's
rollout/evidence documentation. This audit adds only a manual benchmark and
reports. The refreshed architecture/access/settings/reducer/recovery target
passed **38 tests**. The existing production client build and **2,956 Node +
833 React tests** remain applicable because their sources and runtime contracts
have not changed.

Current commands:

```sh
uv build --project backend --out-dir <temporary-build-directory>
uv run --project backend --extra dev ruff check backend
uv run --project backend --extra dev mypy --config-file backend/pyproject.toml backend/relay
uv run --project backend --extra dev --with pip-audit pip-audit --local
RELAY_TEST_DATABASE_URL=<disposable-local-postgres> uv run --project backend --extra dev --with coverage coverage run --source=relay -m pytest backend/tests -q
```

The build produced a wheel and sdist; the wheel contains all 449 modules and
`relay = relay.cli:main`. Ruff and mypy passed. The Python advisory audit found no
known vulnerabilities. The probe refused a non-loopback database URL before
opening a database connection and created no output for that rejected run.
Scratch-schema enumeration after probe completion returned no remaining probe
schemas. The final whole-runtime run passed **3,811 tests**, without skips, in
473.28 seconds. Coverage includes **449 files**, **27,825 / 30,284 executable
statements (91.88%, displayed as 92%)**, above the 80% gate. Branch coverage was
not collected. The [coverage summary](data/backend-coverage-summary.json) records
the totals. The final probe additionally queried stored routine snapshots and
verified one occurrence per routine, beyond checking aggregate firing totals.

## Workload characterization

See [the reproducible probe and measurements](backend-control-plane-probe.md),
[constrained-pool raw results](data/control-plane-constrained-pool.json), and
[default-pool raw results](data/control-plane-default-pool.json).

These are local, instrumented, closed-loop ASGI measurements on PostgreSQL, not
an HTTP/proxy/network benchmark or a production SLA. Autonomous background loops
are disabled; a real automation service is invoked in a worker thread against
the same application pool to create controlled contention. No daemon or agent
execution, provider calls, or production data are involved.

## Explicit design limits

- Complete legacy detail/list contracts retain requested histories; optimized
  summaries and scoped queries provide the normal frontend path. Silently
  truncating those contracts would be a behavior change, not this refactor.
- The automation transaction lock remains the consistency seam for bounded work.
  The candidate union still filters/sorts eligible IDs in the database, and a
  selected detail record can grow with its own history. This is an explicit
  design tradeoff, with bounded batch controls and measurements, rather than a
  claim that every operation has constant database cost.
- Provider-operation guards retain one dedicated async connection per in-flight
  operation; their cleanup and mutual exclusion are tested, and those connections
  must be included in a deployment's budget. The local probe does not generate
  external provider calls.
- Pool/worker/batch budgets must be chosen for the deployment's database budget.
  Increasing connections did not automatically improve this local probe. Multi-
  host throughput, long-duration soak behavior, remote provider latency, daemon
  stream capacity, and a supported user/Computer count require a deployment
  workload and are not promised by this code refactor.
- Run migrations through 0119 before the new deployment, with old backends and
  workers stopped. Follow the credential-key and partial-routing rollback notes
  in [backend scalability](../backend-scalability.md). No deployment, push, or
  production resource mutation was requested or performed.

## Completion decision

The refactoring objective is achieved against the requirements above. The audit
has no missing or unverified refactoring requirement: organization is enforced by
whole-runtime structural gates; behavior, concurrency, rollback, and migration
contracts have passing regression evidence; work reductions have bounded-query
checks and reproducible local measurements; and build/static/coverage/advisory
gates passed. The explicit operational limits above remain visible, without a
claim of production capacity or a request to deploy. No production runtime code
was changed during this final audit.
