# Chat integration backend

Chat channels are disabled by default. The backend retains integration storage,
provider health/provisioning, identity mapping, and chat-service API routes.
The former `relay-chat` gateway package and `relay-chat-server` executable have
been removed. Enabling the feature does not install a working bot or webhook
gateway; a separately implemented client must handle provider events.

## Enable the retained surfaces

- Set `RELAY_CHANNELS_ENABLED=1` on the backend to mount
  `/api/v1/admin/chat-integrations` and `/api/v1/internal/chat/*`.
- Build the web client with `NEXT_PUBLIC_RELAY_CHANNELS_ENABLED=1` to expose
  Channels in the interface.
- Configure `RELAY_CHAT_TOKEN` for the chat-service bearer credential.
- Configure and retain `RELAY_CHAT_SECRET_KEY`, a Fernet key, for encrypted
  provider credentials. Keep both secrets in the deployment's secret manager.

Admin routes manage integration configuration, activation, health checks,
webhook secrets, and identity links. Provider metadata supports Discord,
Telegram, and Lark. Telegram activation can provision a webhook; enabling this
backend alone does not supply its receiving service.

## Identity and access

An external client resolves provider identity through
`POST /api/v1/internal/chat/identity/resolve`. Active identity links associate
provider, external User, and optional tenant identifiers with a Relay User.
Authorization is enforced by the backend, including ownership checks on
conversation/session bindings.

Chat-service calls authenticate with `Authorization: Bearer <RELAY_CHAT_TOKEN>`.
User-scoped calls carry `X-Relay-User-Id`; this is a non-admin actor restricted
to that User's accessible records. The runtime integration endpoint,
`GET /api/v1/internal/chat/integrations/runtime`, returns active provider settings
only to the chat service. Never expose its answer or credentials to a browser.

The [API reference](../api.md) owns current routes and concurrency behavior.
Route implementations are in `backend/relay/api/chat/`; pure provider rules and
health/provisioning are in `backend/relay/chat/`.

## Storage, concurrency, and upgrades

`backend/relay/persistence/chat/` stores indexed configuration, per-integration
encrypted credentials, audit entries, conversation bindings, and identity links.
Public metadata returns credential key names without decrypting values.
Provider activation, health checks, and secret rotation are exclusive per
integration across PostgreSQL replicas; conflicting operations return 409.

Budget one additional PostgreSQL connection per in-flight provider operation,
in addition to the API/worker pools and notification connections. The guard
holds a dedicated transaction through the provider wait without retaining a
mutable configuration row lock. Cancellation or provider failure releases it.

When upgrading from shared-document storage, stop old API and worker processes
before migrating; older writers do not participate in the new coordination.
Retain the existing encryption key. Follow the
[chat migration and rollback cautions](backend-operations.md#per-integration-chat-configuration-and-credentials)
and [migration guide](../../backend/migrations/README.md).

Regression coverage lives in the backend chat API, concurrency, coordination,
credential migration, and query-bound tests. Provider network tests use local
fixtures; they do not establish a working production gateway deployment.
