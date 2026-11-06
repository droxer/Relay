# Connections

Connections let a User authenticate an external service and explicitly select
the resources and actions a Thread, Task, or Automation may use. Open
**Settings → Connections**, connect a service, and choose it in the work's
**Connections** section. Multiple external accounts are supported.

GitHub is the only supported provider for now:

| Service | Actions | Resources |
| --- | --- | --- |
| GitHub | Read up to 50 issues per call; optional open/closed/all filter | Selected repositories |

Agents receive a per-run MCP tool through Codex or Claude. Other runtimes are
refused when work selects Connections. Computers must advertise the
`service-connections` capability. The tool process must be able to reach the
backend URL; a VM cannot reach a host-only loopback backend by using its own
loopback address. Use an HTTPS backend reachable from the Computer/VM.

Provider credentials stay encrypted in the backend database. Neither the
browser nor the Computer receives them. A Computer exchanges its active command
lease for a bounded run credential. Every service call checks the current
command lease, its original Grant snapshot, and current non-revoked access.
Removing access or disconnecting stops subsequent calls; already-issued
external requests cannot be recalled.

## Deployment setup

Run database migrations before deploying this code (`make backend-migrate`).
Revision `20261106_0113` adds service Connections, authorization attempts, Grants,
and their event records. New Computers need the updated installer bundle.

Set `RELAY_CONNECTIONS_ENCRYPTION_KEY` to a Fernet key in your secret manager.
Keep it stable across restarts. Changing it without migrating encrypted records
requires Users to reconnect. Never commit this key or provider client secrets.

For each service to enable, configure all three settings:

```text
RELAY_CONNECTIONS_GITHUB_CLIENT_ID
RELAY_CONNECTIONS_GITHUB_CLIENT_SECRET
RELAY_CONNECTIONS_GITHUB_CALLBACK_URL
```

The callback URL must be the deployment's public HTTPS origin followed by
`/api/v1/connections/callback/github`. HTTP is accepted only for localhost
development. Register the exact URL with GitHub. An incomplete or invalid
configuration fails startup; GitHub appears unavailable until configured.

Use a GitHub **OAuth App** for the new provider-neutral flow. It requests
`read:user repo offline_access`; GitHub's repository consent is broader than
Relay's exposed tools. Relay permits only issue reads on explicitly selected
repositories. This is separate from the older, disabled Account GitHub App
installation flow and never reuses its saved credentials. See
[GitHub's authorization documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

## Work and recovery

- New Tasks and Automations save Grants in the same database transaction as
  the work. New Threads save their Grants before daemon delivery. Existing
  standalone Threads save edited access when their next message is sent.
- A Task's linked Threads use its Grants. An Automation occurrence receives
  an immutable access snapshot when its Task is created; its access cannot be
  expanded through Task editing. Removing access from its Automation also
  removes that access from existing snapshots.
- Changing a Grant's resources or actions replaces that Grant. Existing runs
  lose the previous Grant, and adding the permission back cannot restore it to
  those runs. An unchanged Grant keeps its identity. Generated Tasks referring
  to a replaced Automation Grant require a new Automation occurrence to use
  the new access. Submitted Grant IDs and revisions are checked for stale edits.
- Schedules, Relay events, generic webhooks, and Run now can all use Connections.
  Native provider-event subscriptions are future work; connecting GitHub does
  not create a service-event trigger.
- Unavailable required access pauses an Automation before another occurrence is
  created. Reconnect the same external identity, then explicitly Resume. Resume
  checks access and uses the existing schedule cutoff instead of replaying
  missed runs.
- Disconnect invalidates future calls and pauses active dependent Automations.
  Work history remains. User deletion retires credentials and pending
  authorizations in the deletion transaction. Local disconnect does not revoke
  the provider's application installation; remove it in provider settings when
  that is desired.
- A failed write is never retried automatically. If the response is lost after
  a provider may have accepted it, inspect the external resource before retrying.

Public GitHub issue import remains anonymous and public-only. Connections do not
change the importer's visibility contract. The legacy `/account/github` API
remains disabled except for credential cleanup.

## API

All browser endpoints require the signed-in owning User. An admin does not gain
access to another User's Connections. OAuth callbacks additionally require the
initiating session and a single-use, ten-minute authorization state.

| Endpoint under `/api/v1` | Purpose |
| --- | --- |
| `GET /connection-providers` | Deployment availability and supported actions |
| `GET /connections` | Redacted identities and connection state |
| `POST /connections/authorizations` | Begin authentication or reconnect |
| `GET /connections/callback/{provider}` | Complete provider authorization |
| `GET /connections/{id}/resources?cursor=…` | Paginated provider resources |
| `GET /connections/{id}/usage` | Work referencing the Connection |
| `DELETE /connections/{id}` | Disconnect and pause dependent Automations |
| `GET /connection-grants/{thread\|task\|automation}/{id}` | Read effective work configuration |
| `PUT /connection-grants/{thread\|task\|automation}/{id}` | Replace explicit work access |

Task create/PATCH and new `/agent-runs` requests also accept `connectionGrants`.
Each entry contains `connectionId`, `resources` (provider resource identifiers),
and `actions` (catalog action identifiers). Preserve the returned `id` and
`revision` when editing existing entries; a stale pair returns 409
`connection_grants_changed`. An empty array clears access.

`POST /daemon-nodes/{nodeId}/commands/{commandId}/connections` requires that
Computer's node credential and the active command lease. It returns a run
credential for `POST /connection-tools`, a stateless JSON-RPC endpoint used by
the runtime's stdio MCP proxy. A browser session never grants broker access.

## Verification boundaries

Automated tests use deterministic provider HTTP transports and actual database,
HTTP-route, command-delivery, and stdio transport paths. They do not prove that
an operator's registered OAuth applications, consent policies, network routes,
or real accounts are configured correctly. Perform a deployment smoke test for
each enabled provider: authenticate, select a resource on work, run the Agent,
check the external result, disconnect, and confirm that further calls fail.

See [the design](connections-design.md) for the broader intended model and
[test evidence](testing/connections.tdd.md) for commands and results.
