# Indexed chat records and scoped thread histories

This continues the backend refactoring goal: improve Python module ownership,
bounded work, and replica-safe persistence while preserving existing responses.

## Guarantees and design

- Full browser and chat-service thread lists filter by owner in SQL before
  loading event histories. Chat lists exclude archived threads there as well.
  Default full-record responses retain their events and completed logs. Event
  lookups use batches of at most 500 IDs, with a stable updated-time/ID order.
- Invalid chat identities fail before any session query. Invalid PostgreSQL
  owner identifiers return an empty store result instead of a UUID bind error.
- `chat_audit_events` stores one payload per append. A sequence preserves append
  order, including tied/backward timestamps and duplicate legacy payload IDs.
  Integration/sequence and primary-key indexes support bounded tail reads.
  Filtering and the existing 1–200 limit happen in SQL; the selected tail still
  returns oldest first. Audit and integration mutations share a transaction.
- `chat_conversations` indexes each binding by a SHA-256 key hash and verifies
  its full key on lookup. Raw keys and complete payloads remain stored, so long
  external identifiers and extension fields survive without truncation or
  PostgreSQL B-tree entry-size failures. A session index supports scoped clears.
  Upserts lock only their own key and retain creation time and prior message IDs.
- SQL for growing records lives in `persistence/chat/audit.py` and
  `conversations.py`; SQLite conversion lives in `backfill.py`. The chat store
  handles payload construction and configuration. The artifact route uses its
  database projection interface directly; the retired full-history fallback was
  removed and the interface is declared on `SessionStore`.

## Migration and rollout

PostgreSQL revision **`20261106_0116`** creates the two record tables, validates
legacy arrays, copies their complete payloads and original array order inside
PostgreSQL, advances the sequences, creates the indexes, and removes only the
consumed `audit`/`conversations` documents. Configuration and encrypted secrets
are untouched. No secret decryption key is needed for conversion.

Stop old backend **and worker** processes before `make backend-migrate`, then
start the new code. Old writers still use the arrays and must not run alongside
new writers. Startup checks require the new tables and refuse stale legacy
copies. If copies appear after upgrade, stop old writers and reconcile those
records; rerunning an already-applied Alembic head is not a reconciliation.

The backfill is one transaction over new tables, not a concurrent alteration of
an existing large index. Schedule a maintenance window and allow disk headroom:
legacy payloads remain present until commit. Malformed arrays/records and
ambiguous duplicate binding keys abort the transaction and retain the source
and old revision. Correct the source data explicitly and retry.

SQLite development databases create tables from metadata and convert the two
legacy record arrays once, in one transaction with insert batches of 500.
Conversion is idempotent. Validation failure retains the legacy documents and
leaves target records unchanged. Normal service starts after conversion.

With all backend/worker processes stopped, downgrading to `20261106_0115`
reconstructs legacy arrays from **all** normalized records, including writes
made after upgrade, then drops the new tables. Payloads and record order survive;
the internal legacy document row IDs/update times are recreated. Start old code
only after that downgrade. A backup remains the recovery option for unrelated
failures; no production migration was performed in this task.

## TDD evidence

| Guarantee | RED evidence | GREEN evidence |
| --- | --- | --- |
| Scope history before hydration; bound event parameters | `52c967eb`: missing owner-scoping interface, unscoped API calls, and a 503-parameter lookup failed four tests | `a3510431`: 42 regressions passed; 503 full records use one snapshot query and two bounded history batches |
| Replace growing arrays and preserve legacy data | `96f3ce2a`: four storage/conversion cases and two real PostgreSQL migration cases failed | `e0aa3933`: storage/API tests and migration round-trip/schema-drift tests passed |
| Independent conversation keys progress concurrently | Updated the former shared-document test to exercise real row queries | Separate PostgreSQL stores update different keys while one is paused; same-key requests wait, then preserve the final binding |
| Handle long external keys and invalid owners | `2d501078`: an 8 KiB key exceeded PostgreSQL's index-entry limit; an invalid UUID owner caused a bind error | `33969cbf`: 16 tests passed; full-key Unicode migration/lookup and distinct suffixes are preserved |
| Roll back malformed legacy input and mutation/audit changes | Malformed arrays, invalid record types/IDs, missing fields, and duplicate keys are exercised | SQLite and PostgreSQL retain source state; PostgreSQL retains revision 0115 and retries cleanly; a forced failure after audit insertion rolls back both audit and configuration |
| Invalid chat identity must not remove user scoping | `0a9a26e1`: missing, empty, and non-string owners reached the list path | `aba62f5e`: 34 targeted regressions passed, followed by 12 fresh conversation/auth tests |

The migration round-trip retains unknown fields, duplicate audit payload IDs,
backward/tied timestamps, long Unicode keys, and an unchanged encrypted envelope.
A new mutation after import verifies sequence continuation; downgrade/re-upgrade
preserves that mutation too. Startup tests cover missing tables and stale arrays.

## Verification

- Full backend suite with live PostgreSQL checks: **3,758 passed**.
- Final scope fix: **34 passed**, then **12 passed** in a fresh authorization run.
  This fix followed the full run; it adds three fail-closed identity regressions.
- Focused storage/migration/concurrency/API/architecture suite: **63 passed**.
- Chat APIs and storage tests on the PostgreSQL stand-in: **28 passed**.
- Statement coverage across the measured runtime modules: **92%** (959 statements,
  78 missed). New audit, conversation, and SQLite-conversion helpers: **100%**.
  Session read module: **100%**. These are statement figures, not SQL branch coverage.
- Production build, **2,956 Node tests**, and **833 React tests** passed.
- Ruff passed; mypy reported zero errors in 442 runtime source files.
- `pip-audit --local`: no known vulnerabilities; no dependency changes.

Validation used a disposable PostgreSQL 17 cluster and scratch schemas. Set
`RELAY_TEST_DATABASE_URL` to a test database with an explicit host/port and no
base-URL query parameters. The API stand-in run additionally uses
`RELAY_TEST_STORE_BACKEND=postgres`.

Commands use `uv run --project backend --extra dev`:

```text
pytest backend/tests -q
pytest backend/tests/unit/test_chat_record_storage.py backend/tests/unit/test_chat_record_migration.py backend/tests/unit/test_chat_concurrency.py backend/tests/unit/test_session_list_bounds.py backend/tests/api/test_chat_conversations.py backend/tests/api/test_chat_integrations.py backend/tests/api/test_chat_coordination.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py -q
pytest backend/tests/unit/test_session_list_bounds.py backend/tests/unit/test_chat_record_storage.py backend/tests/api/test_chat_conversations.py backend/tests/api/test_chat_integrations.py -q
pytest backend/tests/api/test_chat_conversations.py backend/tests/api/test_chat_integrations.py backend/tests/api/test_route_auth.py backend/tests/unit/test_chat_record_storage.py backend/tests/unit/test_session_list_bounds.py -q
```

The full run used `--with coverage coverage run` with
`--source=relay.persistence.chat,relay.chat.integrations,relay.persistence.session.reads,relay.api.chat.gateway,relay.api.threads.reads,relay.bootstrap.stores`.
The final conversation/auth run appended coverage at the same source locations.

## Remaining scope

The larger refactoring goal stays active. The [configuration follow-up](backend-chat-configuration.tdd.md)
replaces the remaining shared configuration and credential documents. Legacy full thread responses still transfer the
selected user's complete histories; explicit summary/pagination contracts can
reduce those payloads further. Production capacity, p95 latency, and pool wait
under an intended workload have not been established by these correctness and
work-bound checks.
