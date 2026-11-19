# Connections

Connections let a User authenticate an external service and explicitly select
the resources and actions a Thread, Task, or Automation may use. Open
**Settings → Connections**, connect a service, and choose it in a Task or
Automation’s **Connections** section. The chat input box does not expose a
Connections picker. Multiple external accounts are supported.

| Service | Actions | Resources |
| --- | --- | --- |
| GitHub | Read up to 50 issues per call; optional open/closed/all filter | Selected repositories |
| Gmail | List messages and optionally read message bodies | Inbox of a personal Gmail or Google Workspace mailbox |
| Outlook | List messages and optionally read message bodies | Inbox of an Outlook.com or Microsoft 365 work/school mailbox |

For Gmail and Outlook, choose the mailbox and Inbox in the work's **Connections**
section. Grant **List messages** for sender, subject, received time, and unread
status. Grant **Read message bodies** as well to let work retrieve the plain-text
body. Mail data returned to an Agent is visible to its runtime and model provider
and can appear in work history or runtime session logs. The email tools support
read-only Inbox access. Sending, replying, attachments, and mail triggers are
outside the available access.

Agents receive a per-run MCP tool through Codex or Claude. Other runtimes are
refused when work selects Connections. Computers must advertise the
`service-connections` capability. The tool process must be able to reach the
backend URL; a VM cannot reach a host-only loopback backend by using its own
loopback address. Use an HTTPS backend reachable from the Computer/VM.

This is separate from [Relay MCP](project-manager.md#mcp-tools), which
reads Relay Project records and stages Task proposals at `/api/v1/mcp`.
Connections expose `connection_call` at `/api/v1/connection-tools` using their
own run credentials and work Grants. A Relay MCP token does not authorize this
endpoint. See the [architecture](../system-architecture.md#41-implemented-mcp-boundaries)
for the two tool boundaries.

Provider credentials stay encrypted in the backend database. Neither the
browser nor the Computer receives them. A Computer exchanges its active command
lease for a bounded run credential. Every service call checks the current
command lease, its original Grant snapshot, and current non-revoked access.
Removing access or disconnecting stops subsequent calls; already-issued
external requests cannot be recalled.

## Deployment setup

### Backend variables

For the Railway deployment, set the variables in **Production → relay-backend →
Variables**. The release script makes `relay-worker` reference the backend
variables. For a manual deployment with a separate worker, give it the same
values through service variable references. Store the OAuth credentials and
encryption key on the backend and worker. [Railway deployment](../../deploy/README.md#railway-service-configuration).

Reuse the existing `RELAY_CONNECTIONS_ENCRYPTION_KEY` if GitHub Connections are
already configured. For a fresh installation, generate a Fernet key once and
save it in your secret manager. Changing it without migrating the encrypted
records requires Users to reconnect.

```bash
uv run --project backend python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

The example uses Relay's production API origin, `https://api.get-relay.cc`.
For a different deployment, use its public HTTPS API origin and register the
exact same URL with the provider. HTTP is accepted only for localhost
development. Exclude OAuth callback query strings from proxy access logs as
they contain short-lived authorization codes.

```dotenv
RELAY_CONNECTIONS_ENCRYPTION_KEY=<existing-or-new-Fernet-key>

RELAY_CONNECTIONS_GMAIL_CLIENT_ID=<Google-OAuth-client-ID>
RELAY_CONNECTIONS_GMAIL_CLIENT_SECRET=<Google-OAuth-client-secret>
RELAY_CONNECTIONS_GMAIL_CALLBACK_URL=https://api.get-relay.cc/api/v1/connections/callback/gmail

RELAY_CONNECTIONS_OUTLOOK_CLIENT_ID=<Entra-application-client-ID>
RELAY_CONNECTIONS_OUTLOOK_CLIENT_SECRET=<Entra-client-secret-value>
RELAY_CONNECTIONS_OUTLOOK_CALLBACK_URL=https://api.get-relay.cc/api/v1/connections/callback/outlook
```

Set all three variables for each provider you enable. Leave that provider's
three variables unset when deferring its launch. It will appear unavailable in
Settings. An incomplete or invalid configuration fails startup.

### OAuth app registration

Use a GitHub **OAuth App** for the new provider-neutral flow. It requests
`read:user repo offline_access`; GitHub's repository consent is broader than
Relay's exposed tools. Relay permits only issue reads on explicitly selected
repositories. Set `RELAY_CONNECTIONS_GITHUB_CLIENT_ID`,
`RELAY_CONNECTIONS_GITHUB_CLIENT_SECRET`, and
`RELAY_CONNECTIONS_GITHUB_CALLBACK_URL`. Register the public API origin plus
`/api/v1/connections/callback/github` as the callback. This is separate from the
older Account GitHub App installation flow and uses its own credentials.
[GitHub OAuth App authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

For **Gmail**, enable the Gmail API in Google Cloud. Configure the consent screen
in Google Auth Platform, choose **External** for personal Gmail accounts, and
add `https://www.googleapis.com/auth/gmail.readonly` under **Data Access**.
Create a **Web application** OAuth client with the Gmail callback as an
authorized redirect URI. Relay also requests `openid email` and offline access.
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

An External app in **Testing** can authorize listed test Users. Refresh tokens
issued for the Gmail scope in this mode expire after seven days. Before public
enablement, complete Google's restricted-scope verification and required server
security assessment. Review transfers of Gmail data to Agent runtimes and model
providers under Google's Limited Use requirements.
[Google token expiration](https://developers.google.com/identity/protocols/oauth2#expiration),
[Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification),
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy).

For **Outlook**, register a Microsoft Entra application for accounts in any
organizational directory and personal Microsoft accounts. In **Authentication**,
add the Outlook callback under the **Web** platform. In **API permissions**,
add Microsoft Graph delegated `Mail.Read`. Copy the **Application (client) ID**
from **Overview** and the client secret's **Value** from **Certificates &
secrets**. Relay also requests `openid profile offline_access` for identity and
token refresh. An organization can require administrator approval. Verify that
the test identity has a mailbox on the global Microsoft Graph service.
[Microsoft app registration](https://learn.microsoft.com/en-us/graph/auth-register-app-v2),
[Microsoft supported account types](https://learn.microsoft.com/en-us/entra/identity-platform/v2-supported-account-types),
[Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference#mailread).

### Release and smoke test

Publish the release from the configured GitHub branch, normally `main`.
The Railway pre-deploy command runs the database migrations. For a manual
installation, run `make backend-migrate` before starting the new backend.
Gmail and Outlook use the existing Connections tables from revision
`20261106_0114`.

```bash
deploy/deploy.sh release
deploy/deploy.sh verify
```

For each enabled provider, connect a real mailbox in **Settings → Connections**.
Create a Task or Automation with that mailbox's Inbox selected, grant **List
messages** and **Read message bodies**, and ask a Codex or Claude Agent to read
one message. Use a Computer that advertises `service-connections`. For an
Automation, verify it can run again after the provider access token expires.
Disconnect the mailbox and verify that subsequent reads are denied and any
dependent active Automations pause.

## Work and recovery

- New Tasks and Automations save Grants in the same database transaction as
  the work. New Threads created through the API save their Grants before
  daemon delivery.
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
  Native provider-event subscriptions are future work.
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

GitHub issue import defaults to anonymous public reads. In the import drawer,
select a GitHub account to preview and import issues from repositories that
account can access, including private repositories. Both import endpoints accept
an optional `connectionId`, validate its owner and availability, and use the
backend-held credential. Imports do not grant subsequent Tasks access to GitHub.
The legacy `/account/github` API remains disabled except for credential cleanup.

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
HTTP-route, command-delivery, and stdio transport paths. The
[deployment smoke test](#release-and-smoke-test) verifies registered OAuth apps,
consent policies, network routes, and real accounts.

See [the proposal](../proposals/connections-design.md) for unfinished provider
and management extensions, and [local development](../local-development.md)
for verification commands.
