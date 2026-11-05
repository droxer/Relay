# Connections

Status: design reference with the core authentication and work-access flow
implemented. [Connections setup](connections.md) documents the actual provider
scopes, supported runtimes, deployment requirements, and implementation limits.
Native provider-event subscriptions, provider-side revocation jobs, and the
remaining management extensions below remain proposed.

## Outcome

A User authenticates a service once in Connections, then gives a Thread, Task,
or Automation access to selected resources and actions. The User can see which
external identity will act, where it may act, and which work depends on it.
Disconnecting prevents further service calls without deleting work history.

Example: connect GitHub, give a Task read access to one repository, and ask an
Agent to summarize open issues. Reuse that Connection in a Thread discussing
the result or an Automation that produces the summary every Monday. A Slack
Connection can separately permit that Automation to post to one chosen channel.

Authentication establishes available access. A **Connection Grant** assigns a
bounded part of that access to work. Neither an Agent name nor a prompt grants
service access. Connections belong to Users, consistent with private work
ownership; the Account authenticates the person establishing the Connection.

## Current implementation evidence

- `backend/relay/api/accounts/github.py` returns a coming-soon status and 501
  for connection start/callback. Its delete route can remove old credentials.
  `docs/github-connection.md` documents anonymous public issue import.
- `backend/relay/accounts/github_connection.py` and the account persistence
  store retain an older encrypted, Account-scoped authorization implementation.
  They are migration inputs, not evidence of an enabled service.
- `web/src/components/settings/AccountSection.tsx` includes the coming-soon
  GitHub row. `SettingsPage.tsx` uses the shared section rail and option lists.
- `backend/relay/automations/model.py` supports schedule, task event, run event,
  and generic webhook triggers through `routineTriggers`. A service event is
  a new trigger type; a connected service is also useful with existing triggers.
- Admin chat integrations are disabled by default and describe inbound chat
  clients. A personal Slack Connection here provides tools for work; it does
  not implicitly enable an inbound chat gateway or its administrative authority.

## Entry and layout

Use **Settings → Connections** at `/settings/connections`. Account's existing
Connections group becomes a link to this section. Do not add another global
navigation item for the first release. Contextual “Connect a service” links open
the same flow and return to the initiating draft or record.

Inherit `docs/design-system.md` and executable tokens: compact, flat option
lists, system typography, ink controls, semantic status color, light/dark modes.
Use the existing PageHeader, SectionNav, Button, Badge, Field, Select, and drawer
primitives. This is an Operate surface; service branding identifies the provider
without coloring the page or creating a marketplace-style promotional grid.

The section has two groups: **Your connections** and **Available services**.
Search appears when the catalog exceeds ten providers. An unavailable provider
has an explanation such as “Not available on this Relay deployment”; no enabled
Connect button. Coming-soon entries never imply usable capabilities.

```text
Settings         Connections
 Account         Give your work access to the services you use.
 Connections
 Notifications   YOUR CONNECTIONS
 Appearance      GitHub · personal       Connected           Manage
 Language        alex · 2 repositories · Used by 4 items
                 Slack · Studio          Reconnect needed    Reconnect
                 alex@studio.example · #release-notes

                 AVAILABLE SERVICES
                 Google Drive   Read selected files          Connect
```

Labels and counts above are illustrative content, not seed/server data. Rows
show provider, user-defined label, external identity/tenant, access summary,
status text, and an action. Multiple identities of one provider are supported;
the picker always distinguishes them. Management opens a detail drawer with
Identity, Access, Used by, and recent Connection activity. “Add another account”
starts a fresh authorization, while Reconnect preserves an existing identity.

On narrow screens the rail follows existing Settings behavior, rows stack,
and the drawer becomes a full-width sheet. Long identities and resource paths
wrap; actions remain reachable. Keep keyboard traversal, visible focus, labeled
controls, focus restoration, and status announcements. Never rely on color
alone. Provide English and Simplified Chinese copy, including provider errors.

## Authenticate and connect

1. Select a service. Explain the external identity being connected and the
   capabilities requested, with **Continue to {service}** as the primary action.
2. Use the provider-hosted authentication/consent flow. Relay never asks for a
   provider password. Show installation or tenant selection only where required
   by that provider. Use a full-page redirect so mobile and popup blocking work.
3. Validate the callback and verify identity, tenant, resource visibility, and
   granted permissions with the provider. A returned code alone is not success.
4. Return to Relay and choose permitted resources/actions within the provider's
   consent ceiling. If authorization succeeded but setup is unfinished, show
   **Finish setup**; work cannot select that Connection yet.
5. Save and show “Connected as {identity}”. Return to the initiating picker with
   the new Connection highlighted, requiring the User to confirm work access.

Persist an opaque, short-lived return intent and draft handle before leaving.
Do not put prompts, service secrets, or arbitrary redirect URLs in OAuth state.
Restore the draft after callback or cancellation. A cancelled flow leaves any
existing Connection untouched. A lost Relay session requires sign-in and a new
flow; do not attach the callback to whichever User subsequently signs in.

Reconnect must verify the same external identity and tenant. A different account
becomes a new Connection and never silently replaces credentials behind existing
Grants. Expanding permissions needs renewed provider consent when applicable
and explicit updates to affected Grants. It never expands existing work access.

## Use in work

One reusable **Connections** picker shows connected identities first, then
“Connect a service”. Each selected row expands to resources and action choices.
The saved summary reads, for example, “GitHub · personal — acme/relay · Read
issues”. Unselected services provide no access. An empty selection is valid.

| Surface | Selection and lifetime | Visible behavior |
| --- | --- | --- |
| Standalone Thread | Composer context control before first send; editable in Thread details between runs | Compact “Connections · 2” control opens the full summary; changes apply to future runs |
| Task | Connections section in create/edit drawer | Applies to every round and linked Thread; linked Thread shows the Task's access and links to edit it |
| Automation | Connections section alongside instructions, separate from Triggers | Defines access for every generated Task; run details preserve the actual grant revision used |
| Automation run Task | Snapshot of Automation Grants at firing | History remains stable; ordinary edits cannot broaden that generated Task's authority |

No implicit inheritance from all User Connections, a Project, Team, Computer,
or another Thread. Project work selects its own Grants. A Task's linked Thread
does not add a second set. Copying work copies references only after validation
for the current owner and explicit confirmation; it never copies credentials.
Delegates and Team Agents receive only the same run-bounded access as the lead.

Every run uses an immutable Grant snapshot. Narrowing or removing a Grant also
invalidates that access for live runs; expanding a Grant requires a new run.
The server checks current Connection state and revocation on every tool call.
Editing during a run explains that new access applies next run and removed
access stops being usable immediately. The effective permission is always the
intersection of provider consent, Connection resource limits, run Grant snapshot,
and current non-revoked Grant limits.

Before first dispatch, validate the selected Computer/runtime supports service
tools. If unsupported, show “Update this computer to use Connections” and refuse
dispatch with those Grants. Never silently run without a required Connection.
Agents discover allowed actions and resource handles as tools; descriptions
alone in prompts are insufficient. Prompt content and provider documents cannot
alter the permission checks.

## Automation behavior

Existing schedule, Relay event, webhook, and Run now flows can use Connections
without introducing a service trigger. Before activation, show external identity,
resources, and enabled actions under “This automation can…”. Read access is the
default; enabling a write action explicitly authorizes that named action on those
resources for future unattended runs. No new universal approval step is added.

A future **Service event** trigger selects Connection → event → resource filters.
It has a subscription separate from the execution Grants. The UI explains both:
“When an issue opens in acme/relay” and “Run with read access to acme/relay”.
Subscription permission alone never authorizes Agent tools. Signed, verified
provider deliveries enter the existing durable firing path, with per-subscription
delivery deduplication and existing loop/rate controls. Provider-specific event
support is shown only after its adapter and delivery tests exist.

If a required Connection becomes unusable, pause the Automation using the
existing `paused_by_relay` model with a new `connection_unavailable` reason.
Do not create repeated failing Tasks. A fired Task awaiting dispatch is blocked
with a Connection-specific reason; it consumes no new execution reservation.
Reconnect repairs availability but leaves the Automation paused until **Resume**.
Resume validates Grants and subscription access, recomputes schedules from now,
and does not replay missed slots or suppressed provider events. Active runs lose
future service access; their actual execution state still follows daemon evidence.

## State and recovery

| Condition | What the person sees | Work behavior |
| --- | --- | --- |
| Not connected | Connect | Cannot select; unrelated work continues |
| Authorizing | Returning from provider… | Pending attempt expires; retry is safe |
| Setup incomplete | Finish setup | No executable Grants |
| Connected | Identity and access summary | Calls allowed only within effective access |
| Credentials rejected or provider revokes | Reconnect needed | Deny calls; block dispatch and pause dependent Automations |
| Resource removed or scope reduced | Access changed; review affected Grants | Deny affected access; list exact impacted work |
| Provider timeout or rate limit | Temporarily unavailable; retry timing when known | Bounded retries for safe reads; retain Connection identity |
| Disconnected | Historical identity retained in work history | Deny calls and invalidate run credentials |

Do not label an expired but refreshable access token “Reconnect needed”. Refresh
server-side with a cross-process single-flight lock and atomic token rotation.
A transient provider outage does not erase credentials or prove revocation.

Disconnect opens a concrete impact dialog listing dependent active Threads,
unfinished Tasks, and Automations, with paginated “View all”. Copy: “Disconnect
GitHub · personal? New service calls will stop. 3 automations will pause. Work
history will remain.” **Disconnect** is the destructive action. No implicit
cancellation or reservation release. Revoke locally first, remove encrypted
secrets, invalidate authorizations and runtime credentials, then attempt provider
revocation/subscription cleanup through retryable jobs. Explain any provider-side
access that must be removed manually. A new Connection does not reactivate old
Grants; historical references remain readable and explicitly replaceable.

## Data and execution design

Proposed records (metadata and secrets are stored separately):

| Record | Required information |
| --- | --- |
| Provider catalog entry | Stable provider id, display metadata, deployment availability, supported auth/actions/events, scope mapping |
| Connection | Id, owner User, authorizing Account, provider, external subject and tenant ids, display label, setup/credential state, consent/resource limits, revision, timestamps |
| Connection secret | Connection id, encrypted token material, key version, expiry, refresh metadata; never returned to browser or daemon |
| Authorization attempt | Hashed single-use state, session binding, provider, encrypted PKCE verifier where supported, safe return intent, expiry |
| Connection Grant | Connection id, owner, target type/id, stable provider resource ids, permitted action ids, revision, revocation metadata |
| Run access | Run/command/lease ids, Grant snapshot ids/revisions, expiry, hashed bounded credential |
| Service subscription | Connection, Automation, provider subscription/resource ids, verification secret reference, delivery cursor/state |

Store lifecycle and Grant changes as authoritative events with projections;
include Connection revisions in concurrency checks. Keep credential material,
OAuth codes, and tool payload bodies out of events, transcripts, URLs, analytics,
and ordinary logs. Tool activity records action, external identity, resource,
run, outcome, and a redacted provider reference. Service content remains private
to the owning User under the same retention policy as their work.

```text
Browser → Python authorization flow → provider consent → encrypted storage
Browser → save Grants on Thread / Task / Automation
Dispatch → validate ownership + access + runtime capability → daemon command
Daemon → runtime tool adapter → run-bound service broker → provider API
                                           ↑
                             current revocation + resource/action checks
```

The backend coordinates agents and brokers bounded provider HTTP operations;
it never launches agents. A daemon advertises a new service-tools capability.
Its runtime adapters expose only allowlisted tools, using a run-bound credential
outside the writable workspace. The broker validates the active command lease,
User ownership, run, resource, action, expiry, and current revocation on every
call. Do not reuse the Computer's broad node token as the Agent tool credential
or distribute provider tokens to Computers. An unsupported runtime adapter is
unavailable even when its Computer is online.

Provider adapters implement named typed actions rather than arbitrary URL,
HTTP method, or shell execution. Validate resource ids server-side. Allowlist
provider hosts and redirect destinations; bound response sizes, pagination,
timeouts, and per-User/provider quotas. Escape external content in the UI and
treat it as untrusted data in Agent context. Once a write request may have
reached a provider, retry only with provider-supported idempotency or a verified
outcome; otherwise surface an uncertain outcome for review.

## Proposed API and ownership

All browser endpoints below require the signed-in owning User. Other Users,
including admins, cannot enumerate or operate another User's Connections.
Use the existing session/CSRF boundary for mutations. OAuth callbacks validate
the initiating session and expiring single-use state; provider event receivers
use provider signature verification and replay protection instead of browser
authentication. They expose no User data in their responses.

| Proposed endpoint under `/api/v1` | Purpose |
| --- | --- |
| `GET /connection-providers` | Available provider capabilities and deployment status |
| `GET /connections`, `GET /connections/{id}` | Redacted identity/access metadata |
| `POST /connections/authorizations` | Begin connect/reconnect with provider and safe return intent |
| `GET /connections/callback/{provider}` | Validate authorization and redirect to finish setup |
| `PATCH /connections/{id}` | Save label/resource limits using expected revision |
| `GET /connections/{id}/resources` | Bounded, paginated picker resources within verified access |
| `GET /connections/{id}/usage` | Owner-scoped dependent work and impact counts |
| `DELETE /connections/{id}` | Idempotent local revocation plus durable cleanup |

Grants travel through the owning Thread/Task/Automation mutation API as
`connectionGrants`, with expected record revisions and validation before commit.
Generated run snapshots are server-owned. Define machine-readable errors for
unavailable Connection, insufficient access, identity mismatch, stale revision,
and unsupported runtime. Revoked/deleted foreign ids do not disclose ownership.
Broker and provider event routes need separate explicit contracts and auth tests
before enabling either; they are not general browser proxy endpoints.

Add `backend/relay/connections/` for application use cases and provider adapters,
`persistence/connection/` for stores, `persistence/tables/` for declarations,
and `api/connections/` for routes. Shared pure access policy belongs in `core/`
so registry/dispatch code can enforce it without importing upward. Persistence
imports no provider/application code. Wire config, stores, and broker through
bootstrap and AppContext. Keep modules within existing size/layering limits.
The daemon tool transport belongs in relay-daemon; shared wire definitions and
capability vocabulary must match Python and relay-core.

Web work touches Settings routing, the Account link, API/types, query keys,
shared picker, Composer, task drawers, Automation setup, run summaries, locales,
and lazy loading. Connection mutations invalidate Connection details/list/usage
and affected work summaries. SSE updates and polling remain monotonic; callback
return re-fetches authoritative status rather than trusting a query-string flag.

## Migration and delivery

1. Build the provider-neutral lifecycle, ownership, encrypted secret storage,
   Grants, Settings/picker UI, broker, and daemon/runtime capability path.
   Ship behind deployment availability until one provider works end to end.
2. Implement and verify GitHub authentication and bounded read actions through
   Thread, Task, and scheduled Automation. Preserve anonymous public issue import.
   Do not reactivate the old Account-scoped route merely because code exists.
3. Add Slack and Google Drive adapters, resource selectors, and consent copy
   against verified provider documentation. Each advertises only tested actions.
   Slack writes need explicit per-resource authorization; Drive starts with reads.
4. Add service-event subscriptions using the same Connection/Grant model after
   the scheduled/manual path works. This is a separate capability of a provider,
   not a prerequisite for using that provider in Automations.

Use Alembic for new schema. Existing saved GitHub credentials remain disabled;
require fresh consent before new-model use. A migration may retain only safe
identity metadata linked through Account → User after checking ownership. Never
silently grant old credentials to Tasks. The legacy delete endpoint must continue
to remove legacy secrets during transition. Keep `docs/github-connection.md`
accurate until the new behavior is actually enabled. Roll out backend/schema,
then daemon adapters, then UI availability; capability checks guard older clients.
Rollback disables new authorizations and dispatch access while preserving history
and allowing disconnect; it must not restore revoked credentials.

## Acceptance evidence required for implementation

| Scenario | Required evidence |
| --- | --- |
| Authenticate once, reuse in all three surfaces | Browser flow with a test provider plus a gated real-provider smoke test; service calls from Thread, Task, and scheduled Automation |
| External identities remain distinct | Two identities/tenants of one provider; reconnect mismatch cannot replace existing Grants |
| Ownership is enforced | API/store/broker tests with another User, admin, guessed ids, and foreign resources |
| Callback is bounded | Replayed/expired state, wrong session/provider, cancelled flow, open redirect, incomplete setup, and draft restoration checks |
| Permissions cannot expand accidentally | Tool, delegate, Team, copied work, generated Task, and prompt-injection cases denied outside the Grant |
| Run lifecycle is correct | Capability rejection, expired lease, stale command, Grant reduction during a run, disconnect race, refresh race, and broker credential replay tests |
| Automations recover predictably | Missing access pauses before firing, reconnect stays paused, Resume skips missed slots, and no duplicate Task on redelivery |
| Writes do not duplicate | Provider idempotency/uncertain outcome tests; no blind retry after an ambiguous response |
| Secrets stay private | Response/log/event/command inspection; encrypted storage and key-rotation tests; no provider token in workspace files |
| UI is usable | Desktop/mobile, both themes/locales, keyboard and focus checks, loading/empty/error states, long identities, and paginated resource/usage lists |
| Existing behavior survives | Public issue import, existing Automation triggers, route-auth, layering, schema drift, backend types/lint, daemon protocol tests, and web build |

This design is complete as a proposal when authentication, all three work
surfaces, execution authority, revocation, and recovery have explicit contracts.
The feature is implemented only when the evidence above exists; a Settings
catalog or simulated connection state alone does not satisfy the outcome.
