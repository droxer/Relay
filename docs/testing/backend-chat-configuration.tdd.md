# Per-integration chat configuration and credentials

This continues the backend organization, performance, and scalability refactor.
`DatabaseChatIntegrationStore` now lives in `relay.persistence.chat.store`, with
stateless SQL helpers for configuration and encrypted credentials. Pure chat
validation, identity, and conversation rules live in `relay.chat.rules`, a
layering-test policy module. Provider health probes remain in `chat.provider_health`.
There is no compatibility re-export of the old storage module.

## Behavior and work bounds

- Configuration updates touch one integration record. Credential patches decrypt
  and rewrite only that integration's envelope, preserving omitted fields.
- Public lists and individual metadata reads join credential key names without
  loading ciphertext. After legacy conversion, neither decrypts credentials.
- Settings read configuration and credentials in one joined statement. Runtime
  discovery filters active integrations in SQL before decrypting credentials.
- Different integrations can commit independently on PostgreSQL, even using the
  same store object. Same-integration patches serialize before reading and
  preserve disjoint changes. Provider-operation guards still reject conflicts.
- No mutable transaction connection, per-store configuration lock, or readiness
  cache is shared between threads. Rollback and other replicas observe database
  state directly. Pool-size-one reads and writes retain progress.

## Migration and rollback

Revision **20261106_0117** adds ordered `chat_integrations` records with routing
columns and a separate `chat_integration_secrets` table. It preserves full legacy
payloads, order, extension fields, and subsequent writes on round trip. The
credential table deliberately preserves orphan entries without a foreign key.

Upgrade copies configuration with server-side PostgreSQL JSON expansion and
leaves the encrypted credential envelope unchanged. With the configured Fernet
key, the runtime converts that map atomically under a one-time advisory lock.
Steady-state checks use an indexed existence query without reading legacy
payloads or taking that global lock. Empty/missing scopes defer conversion.
SQLite bootstraps configuration in batches of 500 and uses the same credential
bridge. Malformed configuration, missing keys, or damaged credentials preserve
source state for retry; mixed legacy and normalized secret stores fail closed.

Stop all old backend and worker processes before migration. Start the new code
with the existing `RELAY_CHAT_SECRET_KEY`; schema verification requires the new
tables and rejects an unconverted configuration document, while permitting the
pending credential envelope. After conversion, downgrade requires that key in
the migration environment to reconstruct the encrypted legacy map. A missing or
wrong key aborts downgrade atomically. Stop new processes before downgrade.
Only ciphertext is bound into credential writes, including downgrade.

## RED and GREEN evidence

| Guarantee | RED | GREEN |
| --- | --- | --- |
| Selected credential work | `3a1219bd`: public/settings/update cases exposed fleet-wide decryption | `f8ae7ed8`: public metadata decrypts zero envelopes; settings and credential patch decrypt exactly one selected envelope |
| Independent integration writes | `3a1219bd`: paused integration blocked the other writer | `f8ae7ed8`: both same-store and separate-store PostgreSQL writes progress, with and without credential patches |
| Normalized secure migration | `3a1219bd`: required schema/conversion absent | `f8ae7ed8`: real Alembic upgrade/runtime conversion/downgrade/re-upgrade preserve payloads, ciphertext protection, orphans, order, and new writes |
| Empty scopes without a key | `4a18511d`: four empty/missing integration reads failed on unrelated legacy credentials | `25c52fdb`: those reads retain their normal result without converting unrelated credentials |

Additional regression checks cover malformed SQLite input, delayed-key retry,
inactive credential corruption, same-integration disjoint patches, provider
cancellation/error cleanup, conflict rejection, and bounded reads. Historical
0116 migration tests explicitly target 0116 so they continue verifying that
revision's envelope-preservation contract independently of 0117.

## Verification

- Full backend suite with optional PostgreSQL checks enabled: **3,780 passed**.
- Focused chat, migration, coordination, layering, and module-size suite: **92 passed**.
- Existing chat APIs and work-bound checks with PostgreSQL-backed stores: **38 passed**.
- PostgreSQL head-schema drift check: **1 passed**.
- Client suites: **2,956 Node tests and 833 React tests passed**.
- `pip-audit`: no known vulnerabilities; local project `relay` is not on PyPI.

Ruff passed; mypy reported zero errors in 446 runtime files. Measured statement
coverage is **89%** across chat persistence, pure rules, provider probes, API
routes, and store bootstrap. The store is **92%**, configuration SQL helpers
**97%**, credential conversion/helpers **88%**, and SQLite configuration backfill
**100%**. Existing coordination, audit, and conversation modules are **100%**.
The provider probe module is **62%**; external providers were not contacted.

The full backend run used `coverage run` with
`--source=relay.persistence.chat,relay.chat.rules,relay.chat.provider_health,relay.bootstrap.stores,relay.api.chat`.
The final API import cleanup was checked separately: **9 passed**.

Reproduce with `uv run --project backend --extra dev pytest backend/tests -q`
using a disposable `RELAY_TEST_DATABASE_URL` to include PostgreSQL checks.
`RELAY_TEST_STORE_BACKEND=postgres` selects PostgreSQL for store fixture cases.
The client verification command is `npm run test:ts`.

## Remaining scope

The broader refactoring goal remains active. These tests establish bounded
credential work and concurrent progress, not production throughput, p95 latency,
or pool wait under a target workload. Full thread responses still carry selected
users' complete histories; further reduction needs an explicit API contract.
