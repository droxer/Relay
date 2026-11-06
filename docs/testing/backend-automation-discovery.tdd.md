# Bounded automation discovery and durable routing

Journeys were derived from the current backend audit, without an external plan:
large routine catalogs must not monopolize a scheduler tick; a targeted event
must not load that catalog; broadcasts must eventually reach each eligible
recipient despite restarts/failures; and permanently in-flight routines must not
starve other candidates. Existing occurrence, ownership, resume, and retry rules
remain authoritative.

## Design and work bounds

`persistence/automation/discovery.py` owns narrow read models and the durable
round-robin candidate cursor. It queries only candidate IDs and routing facts
(ID, creation time, owner, trigger definitions), rather than complete snapshots
or pending payloads. For configured batch B, a tick claims at most B outbox rows,
examines at most B broadcast listener projections, and fetches at most B
schedule/pending candidate IDs. At most 3B distinct routines can be processed.
The database still examines eligible candidates and orders IDs; this is a bound
on transferred rows and mutation work, not constant-time database discovery.

A broadcast stores its creation-time cutoff and last `(created_at, id)` recipient
position. New definitions after that cutoff are excluded; existing recipients
are checked against current active state, ownership, triggers, loop prevention,
and resume cutoff before delivery. Broadcasts share one routing budget and move
to the back of the waiting work after a page. Targeted rows skip catalog scans.
Per-routine savepoints retain failure isolation. Failed recipients become
individual retries with their original provenance and timestamps. Routing and
candidate progress commit with deliveries/firing in the existing automation
transaction. The standalone matcher drain now has that same atomic scope.
Retention deletes one bounded page rather than an unlimited expired backlog.

## RED and GREEN

- RED `4ac0f930`: **5 failed**. A targeted event called catalog discovery; one
  broadcast visited the fleet in one tick; pending discovery processed all
  candidates; full-snapshot list methods were required; and a retried broadcast
  resumed with unbounded work.
- GREEN `d27103ad`: the same **5 tests passed** after bounded routing and persisted
  candidate scans were implemented.
- Refactor `990366e1`: bounded projections and migration verification; focused
  regression/API/architecture suite **203 passed**. PostgreSQL-targeted suite
  **101 passed** (fixtures explicitly using SQLite retain that dialect).
- Expanded tests cover shared budgets, page failure retries, a fixed creation
  cutoff, tied timestamps, standalone drain rollback, and bounded retention.
  The two-event assertion was corrected to preserve existing pre-firing
  coalescing, and its fixture given a source ID for context rendering. The final
  bounds/migration target passed **13 tests**; all **11 bounds tests** also passed
  with PostgreSQL-backed store fixtures.

## Guarantees

| Guarantee | Evidence | Type |
| --- | --- | --- |
| Targeted work skips catalog and full discovery | Forbidden legacy catalog/snapshot list methods; one manual event still fires | Database regression |
| Broadcast pages are restart-safe and delivered once | Seven recipients, B=2, repeated service replacement, exactly one occurrence per recipient | Database/restart integration |
| Pending work progresses fairly across store instances | Seven permanently in-flight candidates; two visits per tick; all visited across four ticks | Replica-state regression |
| Progress and occurrences roll back together | Failure after finish writes; no occurrences/cursor consumption; retry reaches all recipients | Fault injection |
| Failed recipients do not replay healthy ones | One recipient fails during a partial page; targeted retry plus continuation reaches all seven once | Fault injection |
| Cursor ordering handles ties and roster changes | Identical timestamps, keyset pages without gaps; definitions created after routing begins excluded | Database regression |
| Standalone drain is atomic | Failure after pending write rolls back both state and routing progress | Fault injection |
| Multiple broadcasts share the budget without loss | Two broadcasts reach five recipients; each event appears exactly once in occurrence context or pending state | Database integration |
| Retention caps deletion work | Seven expired rows, limit two: exactly two removed | Database regression |
| Migration retains payloads and rejects unsafe rollback | Real Alembic round trip; partial progress blocks downgrade while head and cursor remain intact | PostgreSQL migration |
| Concurrent index builds recover | A deliberately failed UNIQUE concurrent build leaves an invalid index; upgrade rebuilds the valid routing index | PostgreSQL migration |

## Rollout and rollback

Stop all old backend and worker processes; run migrations through
`20261106_0119`; start the new code. 0118's nullable columns and cursor table are
transactional. 0119's indexes build concurrently in their own autocommit revision
and can be retried after failure; schema drift is checked against metadata.
Startup rejects a missing discovery schema. Fresh SQLite metadata creates it,
but existing SQLite tables are not automatically upgraded by `create_all`.

For rollback, allow new workers to finish partial broadcasts, stop them, then
run downgrade. Both revisions refuse partial routing before altering indexes or
progress fields, preventing old code from replaying completed pages. Untouched
broadcasts and targeted retries can remain. No credential changes are involved.
Only disposable test databases were migrated; no production migration, provider
request, or daemon execution was performed.

## Verification

Commands use `uv run --project backend --extra dev`:

```sh
pytest backend/tests/unit/test_automation_bounds.py -q
pytest backend/tests/unit/test_automation_bounds.py backend/tests/unit/test_automation_matcher.py backend/tests/unit/test_automation_outbox.py backend/tests/unit/test_automation_clock.py backend/tests/unit/test_automation_trigger_boundaries.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py backend/tests/api/test_automation_triggers_api.py backend/tests/api/test_automation_webhook.py -q
pytest backend/tests/unit/test_automation_discovery_migration.py backend/tests/unit/test_schema_drift.py -q
```

Real database checks use a disposable `RELAY_TEST_DATABASE_URL`;
`RELAY_TEST_STORE_BACKEND=postgres` selects PostgreSQL for store fixtures.
Statement coverage across discovery, store, matcher, and service is **92%**:
discovery **100%**, store **96%**, matcher **87%**, service **91%**. This was measured
with `--with coverage coverage run` and
`--source=relay.persistence.automation,relay.automations.matcher,relay.automations.service`.
Ruff passed and mypy reported zero errors in **449 runtime files**. `pip-audit
--local` found no known vulnerabilities. Dependencies are unchanged.

Client validation (`npm run test:ts`) passed production builds, **2,956 Node
tests**, and **833 React tests**. The first complete backend run passed **3,810**
tests and found one query-plan fixture still pinning the retired listener index.
`a2e5ba9c` updated it to the replacement composite index; the complete task-store
file passed **36 tests**, including SQLite's `INDEXED BY` eligibility check.
The final full backend rerun passed **3,811 tests**, with no skips, in 451.45
seconds:
`RELAY_TEST_DATABASE_URL=<disposable PostgreSQL URL> uv run --project backend --extra dev pytest backend/tests -q`.
`git diff --check` passed. Only disposable test database schemas were changed;
the test cluster was stopped and removed after verification.

## Remaining scope

The global automation transaction lock remains the consistency seam; its work is
now bounded but its pool/lock wait under deployment load is not measured here.
A selected routine can still have a large full detail record or history. The
candidate union still filters/sorts eligible IDs in the database. Representative
load measurements and the broader backend audit remain active; these checks do
not establish supported throughput, p95 latency, or production capacity.
