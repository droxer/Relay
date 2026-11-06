# Chat coordination and bounded reads

This continues the backend design, organization, performance, and scalability
refactor. It addresses shared chat documents, provider side effects, bounded
connection pools, and repeated secret reads. It does not establish production
throughput or complete the broader backend audit.

## User journeys

- Two backend replicas can create/update chat integrations, secrets, audit
  entries, and conversation bindings without overwriting each other's writes.
- An administrator can rotate a webhook secret while incoming webhooks already
  use the newly committed secret. A second backend cannot provision or change
  those credentials until the first operation finishes.
- Cancellation and provider errors release coordination so the next operation
  can proceed. Unrelated integrations and display-only edits remain available.
- A queued writer does not take the last database connection away from the
  reader that must finish before that writer can proceed.
- Listing public/runtime integrations reads the shared documents and decrypts
  secrets once, preserving public redaction and runtime credentials.

## Design

`DatabaseChatIntegrationStore._atomic_scope` now obtains a PostgreSQL transaction
advisory lock before reading documents it will modify. Configuration, secrets,
and audit share one lock because they update shared JSON documents together.
Conversation bindings have a separate document-group lock. SQLite continues to
serialize writes with its existing immediate transactions.

`persistence/chat/coordination.py` owns provider coordination. Async operations
use a dedicated psycopg connection with a transaction advisory lock for the
integration. This coordination transaction writes no documents. Individual
store transactions still commit before awaiting the provider, so a webhook can
use a newly provisioned secret immediately. The guard disables its own idle
transaction timeout so it cannot expire halfway through a provider request;
normal store transaction guards remain enabled.

Configuration edits participate in the same per-integration guard through their
normal synchronous transaction. The local store lock precedes pool checkout to
avoid read starvation at the pool limit. Conflicting operations return HTTP 409
without calling the provider. Guards release on success, errors, cancellation,
and connection close. This is coordination with a healthy database connection,
not an atomic transaction with an external provider; a connection loss during a
provider request still leaves its external outcome to be checked.

The SQLite development fallback uses an active-operation set shared by database
path across app contexts and event loops in one process. Entries exist only
while operations run; the old per-app, ever-growing rotation-lock dictionary
was removed from `AppContext`. Independent backend replicas require PostgreSQL.

Public and runtime lists now load the integration and secret documents together
and reuse their decoded secret map. Single-integration settings use the same
small record formatter and a single document transaction. Public responses
still expose secret configuration/key names only, while the authenticated
internal runtime contract retains the actual credentials.

## RED and GREEN evidence

| Guarantee | RED checkpoint | GREEN evidence |
| --- | --- | --- |
| Independent stores serialize before reading mutable documents | `57bc08b2`: create, update, and conversation tests failed on live PostgreSQL when the second store read before the first committed | `c06dabeb`, then `25a9d864`: concurrent writes preserve integrations, distinct fields, encrypted secret maps, audit entries, and conversation bindings |
| Provider work excludes conflicting replica operations | `57bc08b2`: a second rotation/activation called the provider concurrently; health/config edits incorrectly succeeded | Live PostgreSQL and SQLite cases return 409 and make exactly one provider call; the new secret remains readable during provisioning |
| Provider guards release after interruption and permit independent work | Added as preservation/isolation checks | Cancellation and provider exceptions permit a subsequent operation; another integration, display edits, and conversation binding progress while the first provider request waits |
| Reads progress with a one-connection pool | `06899976`: an earlier read raised SQLAlchemy pool timeout while the queued writer held the only connection | `f732ed7c`: both read and write complete with pool size 1, overflow 0 |
| Lists have bounded document/decryption work | `aee4ea96`: eight integrations required 9 public-list document reads and 17 runtime-list reads | `5b5a46df`: both lists perform 2 document reads and 1 decryption on SQLite and PostgreSQL |

The concurrency tests use separate store objects and PostgreSQL connections.
They pause a real writer after its read, attempt another mutation, and verify
both serialization and committed results. The API coordination tests use fake
provider callbacks, not external provider accounts. No live webhook is changed.

## Verification

- Final full backend suite with optional PostgreSQL checks enabled: **3,735 passed**.
- PostgreSQL schema, rename-migration, and background-worker suites: **28 passed**.
- Final focused suite: **52 passed**, including chat behavior, coordination,
  query bounds, anonymous/admin route protection, layering, and module sizes.
  A final 21-test concurrency/read-bound rerun also verifies rejected conflicts
  leave both credentials unchanged.
- Focused statement coverage: **85%** across the chat store, route module, and
  coordination module; the new coordination module has **100%** coverage.
- Existing chat APIs and query-bound tests on the PostgreSQL store backend:
  **15 passed**.
- Production build and TypeScript suites: **2,956 Node tests and 833 React tests
  passed**.
- Ruff passed; mypy reported zero errors in 439 source files.
- `pip-audit --local` reported no known vulnerabilities; dependencies unchanged.

Commands use `uv run --project backend --extra dev`:

```text
pytest backend/tests/unit/test_chat_concurrency.py backend/tests/unit/test_chat_read_bounds.py backend/tests/api/test_chat_coordination.py backend/tests/unit/test_chat_async_io.py backend/tests/api/test_chat_integrations.py backend/tests/api/test_chat_conversations.py backend/tests/api/test_route_auth.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py -q
pytest backend/tests -q
pytest backend/tests/unit/test_schema_drift.py backend/tests/unit/test_user_rename_migration.py backend/tests/unit/test_background_worker_postgres.py -q
```

The PostgreSQL checks set `RELAY_TEST_DATABASE_URL` to a disposable PostgreSQL 17
database using an explicit localhost host/port and no base-URL query parameters.
An initial private-socket URL exposed older migration/worker fixture assumptions;
using the explicit host/port resolved those setup failures without source changes.
The final full run above uses that corrected test configuration. The API/store-backend run also sets
`RELAY_TEST_STORE_BACKEND=postgres`. Coverage runs the focused command via
`uv run --project backend --extra dev --with coverage coverage run`, with
`--source=relay.persistence.chat.coordination,relay.chat.integrations,relay.api.chat.integrations`.

## Deployment and remaining scope

There is no schema or data-format change. Restart backend replicas together:
older writers do not participate in the new advisory locks. On PostgreSQL,
budget one extra connection per in-flight provider operation, in addition to
the existing store pools and notification connection. The guard uses transaction
advisory locks rather than session locks, retaining a dedicated transaction
through the provider wait; it holds no mutable document row lock.

Shared document writes still transfer whole JSON documents. Normalizing large
conversation/audit collections and bounding history reads remain scalability
work. These tests establish concurrency behavior and query/decryption work
bounds; they do not measure deployment p95 latency, pool wait, or fleet capacity.
