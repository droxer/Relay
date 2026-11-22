# HTTP API and Web URL Contract

Relay's canonical JSON API base is `/api/v1`. The interactive API documents are
available at `/api/docs`, the OpenAPI document at `/api/openapi.json`, and ReDoc
at `/api/redoc`. `GET /api` returns the current version, base path,
documentation locations, and UI metadata from the backend's shared constants.

## Browser URLs

```text
/login
/waitlist
/join#token={inviteToken}
/home
/threads
/tasks
/automations
/computers
/computers/{computerId}/threads
/computers/{computerId}/threads/new
/computers/{computerId}/threads/{threadId}
/computers/{computerId}/tasks
/computers/{computerId}/tasks/{taskId}
/computers/{computerId}/automations
/computers/{computerId}/automations/{automationId}
/computers/{computerId}/automations/{automationId}/runs/{runId}
/projects
/projects/{projectId}
/projects/{projectId}/new
/projects/{projectId}/threads/{threadId}
/agents
/agents/{agentId}
/teams
/teams/{teamId}
/skills
/channels
/admin
```

Standalone work lives under its Computer's stable identity. Project Tasks
open at `/projects/{projectId}?task={taskId}`; Automations and their runs open
at `/projects/{projectId}?tab=automations&automation={automationId}&run={runId}`.
Legacy Thread links and standalone `/tasks` and `/automations` record links
resolve to the record's owning workspace when one is assigned. Project records
opened at global Task or Automation addresses stay in those collections;
explicit Project record links open over the Project board. The main navigation always
opens the global `/threads`, `/tasks`, and `/automations` lists; local Computer
and Project tabs retain their scope. Unplaced records remain readable at their
global addresses. A global Task list's `?project=` parameter filters the list.

A standalone Task or Automation supplies `computerId` when created, mutually
exclusive with `projectId`. The backend checks Computer ownership and constrains
its assignments and dispatch to that Computer. A legacy record may acquire this
scope via PATCH; an existing Computer or recorded workspace cannot be changed.
Creating an Automation, or converting a Task into one, requires `computerId` or
`projectId` (409 `task_workspace_required` otherwise), including paused Automations.
Legacy Automations already stored without scope retain their compatibility routing.
Every agent run requires the daemon's `workspace-scope` capability; an older
client is refused before a run command is published. Backend-issued scope may
include `legacyLayout` (`thread` or `node-root`) only to preserve an existing
standalone workspace binding. It never authorizes a Project workspace.
Project commands also carry the recorded directory as
`workspaceScope.projectWorkspaceSubpath`. A linked directory is created before
its Project and its `links/<linkId>` need not contain the Project id. The daemon
requires the command's path to match this binding exactly. Linked Project runs
require `project-workspace-scope`; clients lacking it must run `relay update`
after the fixed backend and installer bundle are deployed. Directory browsing
does not require this execution capability. Existing directories are preserved.
Missing Task or Automation links keep their address and show record recovery
instead of opening the Computer picker. A Thread deep link waits for the
addressed Thread before canonicalizing its scope; failed routing data must not
leave any deep link waiting indefinitely.

Agent lists use `q` and `availability`. Agent and team details use
`tab`; project details use `tab` plus `path` and `item` on the Workspace tab;
an open thread-space panel writes `space=1` with `artifact`; create dialogs use
`dialog=create`. IDs are percent-encoded path segments. Navigation to another
route or entity removes query state owned by the previous destination.

Unauthenticated deep links are replaced with `/login?returnTo=...`, except
`/waitlist` and `/join`, which are the signed-out pages of the waitlist, and
`/forgot-password` and `/reset-password`, which are the password reset pages. Relay
accepts a return path only when it is same-origin and matches a recognized web
route. `/` is replaced with `/home`.

## API Namespaces

| Namespace | Purpose |
| :- | :- |
| `/api/v1/auth` | Bootstrap, login, logout, current user, preferences |
| `/api/v1/threads` | Session-backed threads, events, artifacts, decisions, handoffs |
| `/api/v1/tasks` | Backlog and automation resources, assignment, pickups, runs |
| `/api/v1/agents`, `/api/v1/teams` | Current-user agents and teams |
| `/api/v1/skills` | User-owned catalog, immutable revisions, and agent grants |
| `/api/v1/admin/agents`, `/api/v1/admin/agent-placements` | Admin logical-agent and placement CRUD |
| `/api/v1/agent-runs` | Ad-hoc agent-targeted run dispatch |
| `/api/v1/projects` | Computer-bound project rosters and shared-workspace rooms |
| `/api/v1/mcp` | Hosted Relay MCP protocol, scoped Project reads/proposals, and MCP token management |
| `/api/v1/connections`, `/api/v1/connection-grants`, `/api/v1/connection-tools` | External-service authentication, explicit work Grants, and run-bound tools |
| `/api/v1/sandboxes`, `/api/v1/daemon-nodes` | Execution-plane observations and commands |
| `/api/v1/artifacts`, `/api/v1/workspace` | Generated artifacts and workspace reads |
| `/api/v1/admin` | Administrative users, users, fleet, agents, teams, and integrations |
| `/api/v1/internal/chat` | Chat-service identity and conversation operations. Mounted, together with `/api/v1/admin/chat-integrations`, only when `RELAY_CHANNELS_ENABLED=1` |
| `/api/v1/daemon-node-registrations` | Daemon heartbeat registration |
| `/api/v1/daemon-node-enrollments` | Managed and local daemon enrollment |
| `/api/v1/waitlist`, `/api/v1/admin/waitlist` | Public waitlist join and invite redemption, and the admin queue and invitations. Only the public join (`POST /waitlist`) depends on `RELAY_WAITLIST_ENABLED=1` |

Persisted media uses `/profile-images/{kind}/{id}` and intentionally stays
outside the JSON version namespace.

### Agent delegation permissions

`PATCH /api/v1/agents/{agentId}` accepts `delegationAgentIds`, an array of at
most 20 other owned Agent ids on the same Computer, or `null`. An omitted or
null setting permits all eligible Agents, including those created later;
an explicit list restricts targets and `[]` disables delegation. Patch with
`null` to restore the default. The equivalent admin agent patch validates targets
against the agent's owner, not the administrator's identity. Invalid, foreign,
self, and cross-Computer targets answer 400. The setting is event-sourced in
the Agent snapshot and returned with Agent records.

On a Computer advertising `direct-delegation` and `work-results`, an individual
action round exposes eligible targets to its runtime. An Agent requests work
through the existing daemon result envelope, using outer `status: "continue"`
and `work: {status: "continue", delegation: {agentId, objective, context?,
acceptanceCriteria, expectedOutputs}}`. The conductor validates this untrusted
request; it is not a new browser dispatch endpoint. Project delegates must be
on the Project Agent roster. A `collaboration.round.started` manifest with
`source: "direct_delegation"` records the requester, delegate, objective,
deliverables, criteria, and the delegate/return assignment ids in `delegation`.
The existing thread event stream carries the manifest and attributed runs.

`GET /api/v1/tasks` returns complete task records for compatibility. Browser
list views may request `GET /api/v1/tasks?view=summary`, which omits `events`
and `activity` and returns `eventCount`, `activityCount`, and `lastActivity`
instead. An optional `limit` is clamped to 1–500; omitting it does not silently
truncate either projection. The summary view accepts `projectId` to select
only the caller's Tasks in that Project before applying the limit. The Project
Dashboard uses this scope and still receives the owner's overall flow usage.
The Home page uses `scope=home` with `view=summary`. It receives fields for
the action queue, upcoming and ready work, prerequisites, and the five most
recently finished Tasks. `homeProjects` carries Project totals, progress and
latest Task updates across the entire account collection. `homeUntriaged`
carries the intake count and its earliest and latest creation timestamps.
The Issues list uses `scope=issues` to exclude Automation definitions.
`view=summary&scope=issues&layout=list` applies Issues filters and ordering
before returning 50 rows, the clamped `page` and matching total, queue counts,
tag choices, and totals for the visible groups. `layout=board` returns up to
10 rows per lane and each lane's position and total. Pass `page` for the
table or `lanes=backlog:2,running:3` for the board. `today` is the browser's
local calendar date for due-date filters. The row projection omits descriptions
and history. A record reads its full description separately, and its Definition
can read the Project's prerequisite references via
`GET /tasks?view=prerequisite-choices&projectId=<id>`.
`scope=board` also excludes generated runs. `scope=automations` reads
Automation definitions and their active occurrences.
`computerId` filters these summary lists to standalone work on the named
Computer. A recorded workspace binding takes precedence. Unbound legacy work
remains available for the browser to place or resolve from its Threads.
`scope=project-dashboard&projectId=<id>&today=<YYYY-MM-DD>` returns Project
issue totals, the overall user's flow usage, and up to five issues to
review. The dashboard uses `attentionTotal` to count the remaining issues.
`GET /tasks?view=summary&threadId=<id>` reads one Thread's originating Task,
work waiting for a reply, active round's Task, and any Tasks that match its
saved suggestions in the same Project or intake. It includes source
Automation names and a versioned `threadTaskContext` so the web can reconcile
changes to suggestions or round scope as they stream in.

The browser opens Tasks and Automations with `GET /api/v1/tasks/{id}?view=record`,
which includes current state, prerequisites, and history counts. It reads the
Task snapshot when current and replays history when recovering a legacy
snapshot. Task Activity reads `/tasks/{id}/events?view=activity` in pages of
25 events by default, starting with the most recent page. Events within a page
are ordered oldest first. It passes `nextBefore` as `before` to read an older
page. `previousStatus` preserves the meaning of the oldest status change in
each page. The default `/events` response still provides the full replay log.
The Thread status timeline uses `/tasks/{id}/events?view=lifecycle` to read
status changes, execution claims, and Thread links in event order.
`GET /tasks/{id}/runs` returns scheduled runs newest first with
`nextCursor`. Pass it as `before` to load an older page. The Runs tab polls
the first page and fetches older pages on demand.
`GET /tasks/{id}/workflow-history` returns `{threads}` with Workflow projections
for all of the Task's linked Threads owned by the caller. Task Activity uses
that response to open the timeline and keeps polling per active Thread.

Personal task lists are scoped to the signed-in user for every role, including
administrators. Tasks and automations appear only for their owner. Both projections apply this scope
before the limit. Personal project lists likewise return only the user's own
projects, including archived projects.

Task, automation, thread, and project details and their history, files, and
mutations require ownership too. Admin status and task assignment do not grant
access to another user's records by ID. Explicit artifact-owner and workspace
selectors must name the signed-in user or a resource they own.

The personal thread, artifact, sandbox, and computer lists likewise default
to the signed-in user's own records. A valid session cookie supplies the
identity even when a saved sandbox UI bearer token is also present; that token
cannot switch the caller to a different user. Token-only legacy clients still
use their UI credential when no session cookie authenticates a person.

A Computer owned by a user with `nodeLocation: "user-device"` accepts file
browsing and work only from its owner. The admin workspace browser and legacy
sandbox read, run, and adoption routes do not grant another administrator
control over that personal Computer. Managed hardware retains its admin policy.

Daemon registration accepts optional `clientVersion`: a SemVer 2.0 release string
(maximum 128 characters), separate from `protocolVersion`. The daemon derives it
from its installed `relay-daemon/package.json`; registration responses and
Computer records return it. Each registration replaces the value; a legacy
daemon that omits it clears any previous value. Existing rows remain unknown
until registration after migration `20261106_0120`. `clientOutdated` and dispatch
compatibility use capabilities. `clientUpdateAvailable` is true when a personal
Computer reports an older release than the installer bundle's `capabilities.json`.
Relay sends at most one `client_outdated` notification per newer release and
includes the target as `availableVersion` in the notification data.

Daemon registration proves execution-plane authority only. An unauthenticated
daemon cannot set or replace a browser UI credential through its bearer header.
Node credentials never authenticate human operations, including when an older
record has the same hash in both credential slots. Such legacy browser clients
must sign in with an account rather than reuse the daemon's secret.

Task lists include `waitingOnSummaries` alongside the authoritative `waitingOn`
IDs. These summaries contain only a direct unfinished prerequisite's id, number,
title, status, responsible user ids/name, and `canOpen`. They are supplied only
when the prerequisite belongs to the same live project and the caller owns both
that project and the prerequisite. A summary never grants access to the full task;
`canOpen` follows the task ownership rule. Missing summaries mean
private or unavailable details, not a resolved dependency.

Home's seven-day Upcoming list uses local calendar dates for task deadlines,
already scheduled occurrences, and each active automation's next known run. It
is not a forecast of every repeat or event/webhook trigger. Ready-work suggestions
require an assigned routable agent/team, a writable project, an online Computer,
and no outstanding prerequisites; the existing task-start endpoint remains the
final authority and may answer started, queued, or rejected.

The thread list (`GET /api/v1/threads`) is a summary projection too. Beside a
thread's open `permissionRequests` it carries `nextSteps` — up to three short
follow-ups a finished turn suggested, empty once anything else happens — so
Home can offer them without opening each thread. The summary view
(`?view=summary`) is paged newest first: `limit` is clamped to 1–200 (default
100), and the answer's `nextCursor` — an opaque token, `null` on the last
page — is passed back as `cursor` for the next page. The page boundary is a
keyset on the thread's last update, so a thread that moves to the top between
two page loads is neither repeated nor skipped. The web rail loads 20 at a
time.

The signed-in web directory requests `?view=summary&include=activity`. Each
row in the requested page then carries `taskActivity` with an `origin`
(`kind`, `taskId`, `ref`, `title`, `status`, or `null` for a chat) and an
`awaitsHuman` flag for settled work. The first page also carries
`homeTaskNeedsYou`, a count of Tasks in review or waiting for the viewer,
excluding snoozed Tasks. Only Task data visible through `GET /api/v1/tasks`
is included. Older pages load with the directory's cursor.

`PATCH /api/v1/auth/preferences` takes any of `theme`, `language`,
`onboarding`, and `homeSnoozes`, and answers `{user}`. `homeSnoozes` is
`{"snooze": [{"key", "stamp"}], "unsnooze": ["key"]}`: Home hides an item
while its current stamp equals the stored one, so a snooze lasts until the
item changes. Keys and stamps are opaque strings of at most 512 characters;
the newest 200 entries are kept, one per key. The account reads them back as
`user.homeSnoozes`.

Automations are stored as routine tasks; the routine* field names are the wire names.

An automation carries `routineTriggers`, 0 to 5 triggers that are OR-ed (an
empty list means Run now only), and at most one `webhook`:

```text
{ kind: "schedule",   schedule: { timezone: string|null, repeat: ... } }
{ kind: "task_event", on: "created"|"status_changed", filters?: {...} }
{ kind: "run_event",  on: "completed"|"failed",       filters?: {...} }
{ kind: "webhook" }
repeat: { every: "hour", minute } | { every: "day"|"weekday", at: "HH:MM" }
      | { every: "week", at, days: [1..7] }   // ISO weekdays, non-empty; duplicates ignored
      | { every: "month", at, day: 1..31 }    // clamps to the month's end
      | { once: "YYYY-MM-DDTHH:MM" } | { cron: "<5 fields>" }
```

A cron repeat may not fire more often than every 15 minutes, and one that never
fires (for example February 31st) is rejected. A null `timezone` means
`RELAY_TASK_SCHEDULER_TIMEZONE`, else the host's IANA zone. Event triggers take
AND-ed `filters`: `projectId`, `assignedAgentId`, `assignedTeamId`, `priority`,
and `titleContains` (up to 120 characters); `fromStatus` and `toStatus` apply
only to task status changes. Filters on project/team/agent require the owner's
assignment access, and broadcast events are scoped to work visible to that owner.

Creating an active automation, changing its triggers while active, or resuming
it rejects an expired one-off with 400 naming
`routineTriggers[index].schedule.repeat.once`. A paused draft may retain a
past date, and an already-active, completed one-off remains editable. With no
future firing it appears as On demand; Run now remains available.

`routineState` is `active`, `paused`, or `paused_by_relay`. A paused automation
carries `routinePauseReason`: `rate_limited`, `failing`, `no_target`, or
`invalid_schedule`. Owners set `active` or `paused`; they cannot set
`paused_by_relay`. Setting `active` resumes it: from `paused_by_relay` it also
starts a fresh hourly rate window, and any resume resets the failure counter.
`routineNextRunAt` is the next schedule firing as an ISO UTC datetime; the
write path sets it when an automation becomes active or its triggers change
(cleared when it is not active), and the scheduler clock seeds missing values
and advances it after each fire.

Relay counts consecutive failed occurrences of an automation, one verdict per
occurrence (the task's status change, not its agent runs: a round may fail a
run and still finish). An occurrence that reaches `done` resets the count to
zero. One whose round failed for good adds one: the closeout blocks it with
`attention.code: "execution_failed"`, or dispatch refused it
(`attention.source: "dispatch"`). A failed agent run inside a round
(`agent_exit_failed`) is not a verdict, because the round may still repair it.
A cancel, a person's own block, a block with no recorded cause,
`waiting_for_human`, `review`, and deletion neither count nor reset. Each occurrence counts at most
once, so a retried occurrence that blocks again is not a second failure. After
3 failed occurrences in a row (`FAILURE_LIMIT`), Relay pauses an active
automation with `routineState: "paused_by_relay"` and
`routinePauseReason: "failing"`, and records it in the automation's activity.

`POST /api/v1/tasks/{id}/automation/resume` turns a paused automation back on.
Only the automation's owner may call it; anyone else gets 403. A
task that is not an automation gets 404. On an already-active automation it
returns the task unchanged. Otherwise it drops pending events, so stale ones
can't fire the moment it resumes, and resets the failure count. It sets
`routineState: "active"`, clears `routinePauseReason`, recomputes
`routineNextRunAt`, records who resumed it in the activity, and returns the
task. Resuming a `paused_by_relay`
automation also starts a fresh hourly rate window. Resuming an owner pause
keeps the window, so pausing and resuming can't get around the hourly cap.
`PATCH` with `routineState: "active"` runs the same reset.
Only an owner may lift a Relay pause through PATCH, including moving
it to an ordinary `paused` state. An assignee may still edit the definition
without lifting that pause and toggle an ordinary owner pause.

The v1 fields (`routineTrigger`, `routineCadence`, `routineEnabled`,
`routineDisabledReason`, `routineNextRunDate`, ...) answer 400 on write and never
appear in a response. Old records and events still replay: the reducer upgrades
them, and a legacy-shaped write to an already-v2 automation only maps its state.
When `RELAY_AUTOMATION_TRIGGERS_ENABLED` is off (default on), writes accept
schedule triggers only; `capabilities.automationTriggers` in `GET /admin/settings`
and `/auth/me` (every user) reports it.

`POST /api/v1/automations/schedule-preview` (any signed-in user) takes
`{schedule}` and returns `{summary, next: [up to three ISO UTC datetimes]}`; an exhausted `once`
returns fewer (or no) times; an invalid schedule answers 400 `{detail}` naming the field.

Every trigger (schedule clock, event outbox, webhook, Run now) fires through
the same pending state. A firing coalesces behind an in-flight occurrence,
schedules included, and slots missed while the backend was down collapse into
one catch-up. Schedule fires are exempt from the hourly cap
(`RELAY_AUTOMATION_MAX_RUNS_PER_HOUR`, default 6). An active automation with
nowhere to run is paused with `paused_by_relay` / `no_target` instead of retried.

Each automation's schedule advance, pending deliveries, and occurrence creation
share a savepoint. A failing automation rolls back its own work while healthy
automations continue. Failed recipients of broadcast events retain targeted
outbox retries, so retrying does not deliver the event again to healthy recipients.

`POST /tasks/{id}/runs` (Run now) is available to the owner,
including on a `paused` automation, but not on one paused by Relay for
`rate_limited`. With nowhere to run it answers with dispatch code `no_target`,
and it never changes the automation's state. A free automation dispatches
immediately through the existing daemon path; one with a run in flight answers
with that run (`automation_running` when it has no live thread), and one whose
request is coalesced with pending events returns `automation_pending`. Run ledger
rows include nullable `triggerKind` and `triggerSummary` (`eventType`, optional
`toStatus`, and `eventCount`), persisted on occurrence events.

Inbound webhooks use `POST /api/v1/automations/{id}/webhook` with JSON and the
`X-Relay-Automation-Token` header. A valid request returns `202 {"accepted": true}`
and queues an occurrence for the scheduler; it does not execute an agent.
Never place the token in the URL. Missing/wrong tokens and unknown ids return
401; paused, deleted, or unavailable webhook automations return 409. Non-JSON
content returns 415, malformed JSON returns 400, bodies over 64 KB return 413,
and rate limiting returns 429 with `Retry-After`.

`GET /api/v1/tasks/{id}/automation/webhook-secret` returns `configured`, `path`,
and `header`, never the secret. `POST` on the same path generates or rotates a
secret and returns it once with status 201. Only an owner
can manage it. The database stores only its SHA-256 hash. Rotating invalidates
the previous token; leaving the webhook kind deletes the stored hash.

Matches arriving while an occurrence is queued or running coalesce into one
next occurrence. Context retains up to 20 events, records overflow counts,
and clips each webhook payload to 8 KB. Pending events expire after 24 hours.
Automations skip their own occurrences and stop chains beyond depth 3. The
hourly cap pauses the definition (`paused_by_relay`, `rate_limited`);
resuming clears the reason and starts a fresh rate window. The run ledger
shows the reason and offers Resume to the owner.


## Normalized Mutations

```text
PATCH  /api/v1/threads/{id}                         { title } or { archived: true }
POST   /api/v1/threads/{id}/cancellations
GET    /api/v1/threads/{id}/queue                  durable follow-up queue
POST   /api/v1/threads/{id}/queue                  { action, id?, text?, addressAgentIds?, addressTeamId? }
POST   /api/v1/threads/{id}/messages               { text, intent, addressAgentIds?, addressTeamId?, style?, userMessageId?, idempotencyKey? }
POST   /api/v1/threads/{id}/recoveries             { kind, targetAgentId, mode, note?, idempotencyKey?, resume? }
PUT    /api/v1/tasks/{id}/assignment
POST   /api/v1/tasks/{id}/runs
POST   /api/v1/tasks/{id}/pickups
PUT    /api/v1/admin/daemon-nodes/{id}/assignment
DELETE /api/v1/admin/daemon-nodes/{id}/assignment
POST   /api/v1/admin/chat-integrations/{id}/activations
POST   /api/v1/admin/chat-integrations/{id}/health-checks
POST   /api/v1/admin/chat-integrations/{id}/webhook-secret-rotations
DELETE /api/v1/admin/managed-nodes/{id}/record
```

Full `GET /api/v1/threads` responses remain complete for the authenticated owner.

The browser hydrates individual threads with
`GET /api/v1/threads/{id}?view=transcript&window=compact`. It receives the
thread fields and a recent event window starting at the zero-based `eventStart`.
At most 160 events are read. The compact window budgets 128 KiB for events and
omits execution briefs from the snapshot. The default window and history pages
budget 384 KiB for events. Every window admits its newest event, even if that
event exceeds the budget. `eventCount` is the exclusive end sequence. Send
`before=<eventStart>` to get the preceding window. A subsequent snapshot request can send
`relayEvents=<start>:<count>:<eventsRevision>` or the equivalent header
`X-Relay-Thread-Events` to reuse the matching prefix of a window. A supported
browser read can send the previous ETag as `relayRevision` to revalidate
with a CORS-simple GET. Standard `If-None-Match` also works.
`eventOffset` identifies the first event returned. The
server sends a new window starting at `eventStart` if older events changed
or the window moved. An `If-None-Match` matching the whole snapshot returns
`304` after access is checked. Transcript responses use `no-store` and the
browser retains validators in its per-Account query cache.

`POST /api/v1/threads/{id}/messages?view=compact` returns execution state
with the bounded recent transcript. Queue reads and writes with `view=versioned` include the
Thread's current `eventCount` so a poll or write response can reconcile with
newer queue events received through SSE.

`GET /api/v1/threads/{id}?view=workflow` returns the Thread's `id`,
`ownerUserId`, `status`, `workflowRuns`, and `activeWorkflowRunId` for
the Task Activities timeline. It uses the same ownership check as Thread
detail and reads the materialized Workflow state without loading the
transcript.

Thread message dispatch can return HTTP 409 with a structured `detail.code`.
`thread_run_active` means the thread already has an execution reservation.
`node_not_accepting_commands` means the Computer is online and its last command
poll is stale or its daemon is draining. `node_offline` indicates an unavailable Computer,
and `capacity_exhausted` indicates that admission found no execution capacity.
Reuse the original message ID and idempotency key when retrying the same send.

Queue `enqueue` and `import` actions retain `addressAgentIds` or
`addressTeamId` until dispatch, including when a message is promoted with
“Stop & send next”. A leading `@Agent` mention takes precedence over supplied Agent ids.
Omitting both targets addresses the room, as for legacy queued messages.
Targets are checked against current ownership, membership, and Placement at
dispatch; an unavailable target pauses the queue rather than selecting another.

Queue `remove` retains the most recently removed message and its next-message
anchor in `removed: { message, beforeId }`. `undo_remove` with that message's
`id` restores its text and recipient before the surviving anchor (or at the
end when that anchor is gone), then clears `removed`. Repeated undo requests
are harmless. The usual owner, active-thread, and 20-message limits apply;
a full queue keeps the undo record so it can be retried. Queue conflicts carry
stable `queue_full`, `queue_sending`, `queue_changed`, or `queue_thread_closed`
codes for localized client recovery messages.

The chat-service conversation list likewise returns the resolved owner's full
open threads. Ownership and archive filtering occur in storage before event
histories are loaded; neither list silently truncates records or replaces them
with summaries.

Admin token reporting at `GET /api/v1/admin/dashboard/tokens?tz=Asia/Shanghai`
uses the viewer's local calendar dates (UTC for a missing/invalid timezone).
Both `/admin/dashboard/sessions` and `/admin/dashboard/tokens` accept inclusive
`start=YYYY-MM-DD` and `end=YYYY-MM-DD` dates plus `tz`. They default to the
last seven calendar days including today. Explicit ranges require both dates
in order and may span at most 366 days. Alternatively, `all_time=true` returns
all retained history and cannot be combined with explicit dates. All-time
charts group histories over 90 days by month, or by year for ten years or
more; `bucketSize` identifies `day`, `month`, or `year`. Totals, chart buckets, and top users
are scoped to the same range; sessions use creation time and tokens use run
completion time. Computer and agent inventory remains current. `fresh` excludes cache
reads, and `unreportedRuns` identifies runtimes that completed without reporting
usage. The `runtimes` array groups the same retained ledger by runtime (`agent`,
including `null` for legacy unknown runtimes), with `runs`, `reportedRuns`,
`fresh`, and `cacheRead`. Runs without reported counts contribute to `runs`
but not token sums; these are retained ledger runs, not live executions.
Totals include retained usage after thread deletion. The backend groups
the ledger in storage and caches each reporting window briefly. See
[dashboard reporting storage and timezone behavior](guides/backend-operations.md#grouped-dashboard-token-metrics).

`GET /api/v1/admin/dashboard/agents` returns `{count}` for the current
fleet across Accounts. The count includes disabled Agents and excludes deleted
ones. The backend caches the aggregate for up to 30 seconds.
`GET /api/v1/admin/dashboard/sessions` includes the display name and handle
of each ranked User whose Account is still in the directory.
`GET /api/v1/admin/daemon-nodes?view=web` includes the owner label for
each Computer whose User is still in the directory. It supports in-memory
revalidation using `If-None-Match` and stays `no-store`. The browser reads
deleted managed Computers through `GET /api/v1/admin/managed-nodes?view=history`,
which filters for completed deletion and returns 20 records by default with
an optional `nextCursor`.

Chat activation, health checks, and webhook-secret rotation are exclusive per
integration across PostgreSQL backend replicas. A conflicting operation, or a
`PATCH /api/v1/admin/chat-integrations/{id}` changing `tenantId`, `config`,
`secrets`, or `status` during one, returns 409; retry after the active operation
finishes. Display-only edits and operations on other integrations can proceed.
Configuration and encrypted credentials are stored per integration. Public
metadata returns credential key names without decrypting values; settings and
runtime access decrypt only the selected or active integrations. See the
[migration 0117 rollout and rollback requirements](guides/backend-operations.md#per-integration-chat-configuration-and-credentials).

An explicit `POST /api/v1/tasks/{id}/runs` retries a plain blocked task after
checking that no dispatch claim or run request owns it. It records the status
change through task events. For an automation definition, Run now queues a fresh
capped firing once the previous occurrence is parked in review or blocked; the
previous run retains its history. A request while an occurrence is queued or running answers with that
occurrence (waking a queued one) and queues nothing, so it never starts a
second run later. Project/team/agent filters need an owner; an ownerless
automation may only use the other filters.
Automatic scheduling never reopens blocked tasks.

Thread collaboration inputs are semantic. `intent` is `accomplish`, `discuss`,
or `review`; omitting `addressAgentId` addresses the current room. Recovery
`kind` is `rerun` or `handoff`. The backend resolves membership, executor,
placement, and immutable round assignments; clients do not send those transport
details.

A `kind: "rerun"` with `resume: true` continues the target agent's own runtime
conversation instead of starting over: daemons advertising `agent-resume` report
the CLI's conversation id as `runtimeSessionId` on `run.completed`/`run.failed`/
`run.cancelled` (stored on the run record), and the rerun's command state carries
it back as `resume_session_id`. Only Claude (`--resume`) and Codex
(`exec resume`) resume today; on an older daemon, or with no recorded
conversation, the rerun simply starts fresh, and a resume whose conversation is
gone falls back to a fresh run on the daemon. Ids are accepted only as plain
`[A-Za-z0-9_-]{8,128}` tokens because they return on a command line.

Use `/threads/{id}/recoveries` with `kind: "handoff"` to dispatch a receiving
logical agent. The legacy `/threads/{id}/handoffs` and handoff decisions under
`/threads/{id}/decisions` record session metadata only; they do not dispatch an
agent. A successful metadata response is not evidence that a receiver started.

For a Project Task or an Automation occurrence, Relay rechecks whether the
receiving Project Agent is enabled before publishing the start command. The
same check applies when Relay recovers a staged command. The receiver joins
the Thread when Relay publishes the command. If the receiver was
disabled or removed, Relay cancels the undelivered command and blocks the Task
with `project_agent_not_member`. You can rerun the Task with an eligible Agent
in the same Thread and workspace.

New rounds record `workScope`: `{ "kind": "thread" }` for thread contributions,
or `{ "kind": "task", "taskId": "..." }` for task executions. Recovery inherits
the active source round's scope, including task workspace checks and required
round verdicts on capable daemons. Missing verdicts leave the task waiting for
a human. New messages start thread-scoped work, even inside task-linked threads.
Links alone never grant task execution ownership. Legacy linked threads without
recorded scope return 409 `work_scope_required`; restart through the task run
endpoint to establish scope. Unlinked legacy threads remain recoverable.

New recovery manifests also freeze `sourceOwnership: { revision, roundId }`
from the source thread's `collaborationRevision` and `activeRoundId`. Admission
checks this token after obtaining the durable active-session reservation and
before recording the decision or receiver round. A replaced source returns 409
`collaboration_conflict` with `handoff_source_changed` in the message; retrying
that idempotency key preserves the rejection. Submit a new recovery after
reviewing the current round. Prepared retries may resume their own recorded
round, but cannot skip past a later round. Legacy prepared manifests without
the token remain replayable; this is not a task-wide or filesystem writer lock.

Thread completion does not update linked tasks without an explicitly scoped
task execution. Likewise, marking a task done only closes linked threads whose
current run request or active round belongs to that task. Routine-template and
reference links remain historical relationships.

Task-scoped work also reserves the task across threads and nodes: only one
daemon run request may be `prepared`, `running`, `dispatching`, or `finalizing`
for a non-null `taskId`. The database enforces this with
`uq_daemon_run_requests_active_task`; the local daemon store serializes creates
and transitions under its process-shared claim lock. One request may still
coordinate several assignments. Unscoped threads do not reserve reference-linked
tasks. A competing recovery returns 409 `collaboration_conflict` with
`task_ownership_conflict` in the message, without replacing the current request.

Database deployments must apply migration `20260913_0068` (`make backend-migrate`).
Pause admissions during deployment. If duplicate active owners already exist,
the migration stops without modifying runs; resolve them through normal lifecycle
operations and confirm writers have stopped before retrying. The constraint
releases when the request becomes terminal, and prevents stale requests from
reactivating over an active replacement. Cancellation intent is not proof that a
process exited.
Pre-delivery cancellation and terminal-session cleanup retain the reservation
when the current command has already been delivered, even if its lease expired.
Cancellation intent alone therefore does not release that delivered reservation;
daemon terminal-event handling remains a separate lifecycle step.
Delivered timeout and retirement stops follow the same rule. Their durable stop
intent is replayed after a publication crash and suppresses lease-expiry
redelivery. A late success acknowledges exit but cannot override that stop.
Terminal acknowledgements recovered after a crash preserve a terminal session's
human decision. Updated POSIX daemons wait for their execution process group to
exit; BoxLite failures wait for confirmed execution exit. An unconfirmable exit
retains ownership and may require operator recovery. Upgrade daemons as well as
backend replicas; escaped/unrelated writers and Windows process trees are not
covered by this guarantee.

New task execution requests also claim a monotonic task revision through
`task.execution.claimed`. Task records expose `executionOwner: { requestId,
revision }`; completion does not erase it. Task-scoped recovery captures
`sourceTaskRevision` in its frozen manifest. A superseded generation returns 409
`collaboration_conflict` with `task_ownership_changed`, including on idempotent
replay. Submit a new recovery after inspecting the current task.

Daemon-originated task status, activity, round/continuation, and workspace-wait
writes check that owner inside the task write transaction. Stale writes append
no task event; stale redispatch is refused even after a replacement finishes.
Round verdicts are recorded once per execution owner, so retrying closeout does
not spend the continuation budget again. Recovery repairs a partial thread/task
completion before retiring the execution request.
Prepared legacy requests use revision zero and cannot write over a versioned
owner. These are control-plane write fences, not filesystem/process leases or
restrictions on deliberate human edits. Upgrade all backend replicas together:
older backends do not enforce this guard. No additional schema migration is
needed for the ownership event and projection.
Manual and scheduler dispatch callbacks also check their claim, owner, and task
status under the task write lock, so delayed bookkeeping cannot reopen completed
work or overwrite a replacement's result.

New handoff rounds include optional `handoffContext` with contract
`relay.handoff.context` version 3 (legacy versions 1 and 2 remain readable). It contains the receiving assignment and
logical agent, linked decision, source event boundary, bounded objective/note
and prior-context excerpts, and run/artifact/handoff-notes references (`progressFile`). Retrying
an accepted operation preserves that context even if the thread later changes.
Versions 2 and 3 require `handoffContext.receipt`, using
`relay.handoff.receipt` version 1. The receipt preserves the work scope, verbatim
task requirements or initial thread objective, current request, and handoff
instruction. Requirements are never truncated: a combined protected-text budget
of 16,000 characters is enforced before admission. The serialized receipt has a
separate 32,000-character ceiling, in addition to the existing 24,000-character
history budget. An oversized new handoff returns a conflict requiring narrower
work; prepared retries reuse the accepted receipt without recapturing it.

For substantial work, agents are instructed to write
a checkpoint beside their handoff notes (`HANDOFF.md` → `HANDOFF.json`;
older contexts that name `PROGRESS.md` keep `PROGRESS.md.handoff.json`) with their assignment ID, completed/pending work,
blockers, failed approaches, verification reports, dirty paths, observed workspace
revision, and next action. These are attributed claims, not completion approval
or new permissions. The existing generated-file pipeline snapshots the file when
reported; the backend never opens daemon workspace paths.

The receipt includes up to 24 source-run artifact references with SHA-256 hashes
when stored bytes are available. Coverage is explicitly partial. Checkpoints
must belong to the source run and match its assignment. Missing, unavailable,
invalid, and stale checkpoints remain explicit unknown-progress states. Hashes
identify historical bytes, not correctness or completion; receiving agents must
still verify relevant work and claims. No new database migration is required.

Version 3 requires the daemon's `handoff-validation` capability. The backend
binds `run.start.handoffValidation` (`relay.handoff.validation` version 1) to the
receipt's receiving assignment, workspace layout/subpath, and artifact references.
A daemon without the capability fails the handoff without publishing a command.
Upgrade backend replicas and daemons before creating version 3 handoffs. Old
backends reject version 3 rather than silently dropping the required validation.
Previously prepared version 1/2 contexts retain their original behavior.

The daemon validates under its physical workspace gate, before receiver
preparation, control-file cleanup, or `run.executing`. Thread, task, project,
and node-root runs all participate in the gate. Recorded hashes must match
bounded regular files (2 MiB per file, at most 24 references). Changed, missing,
oversized, or unsafe files stop the command with `handoff_validation_failed`.
Relative-path traversal and symlinks are rejected; no file contents or host paths
are returned in the failure. Nothing is restored or overwritten. Review changed
work before requesting a new run; replaying the same receipt cannot bless drift.

Null hashes and absent checkpoints remain explicitly unverified, not successful
whole-workspace verification. The receiver prompt records matched/unavailable
counts and partial coverage. The gate coordinates upgraded Relay writers, not
external tools or older daemons that do not acquire it; this is not a hostile-host
sandbox or a Git-tree attestation.

`collaboration.delivery` SSE events carry `roundId`, `assignmentId`, `runId`, and
`status` (`queued` or `running`). `agent.started` alone means the backend staged
an attempt. Daemons acknowledge requested execution with the lease-bound
`run.executing` event; old daemons may instead establish execution through output.

## Projects

`GET /api/v1/projects` returns the current user's active and archived
projects so historical project threads keep their original grouping.
`?view=index` supplies the Projects rail with IDs, names, status, versions,
and member counts. The selected Project can load its roster and setup
indicators through `GET /api/v1/projects/{id}?view=directory`.
The full detail route supplies context, pending suggestions, and member contracts.
The Dashboard reads a Project Lead's identity and availability through
`GET /api/v1/agents/{id}?view=badge`.
Creating a
project binds an immutable stable Computer identity and creates one shared
workspace subpath for every task conversation in that project:

```text
POST /api/v1/projects
{
  "name": "Relay GA",
  "daemonNodeId": "computer-node-id",
  "leadAgentId": "agent-id",
  "members": [{
    "agentId": "agent-id",
    "role": "planner",
    "responsibilities": "Plan and accept delivery",
    "instructions": "Optional project-only instructions"
  }]
}

GET    /api/v1/projects/{id}
PATCH  /api/v1/projects/{id}     { expectedVersion, name?, description?, goal?, context?, leadAgentId?, members?, enabled?, setupResolution?, resolveContextSuggestions? }
POST   /api/v1/projects/{id}/archive?expectedVersion={version}
POST   /api/v1/projects/{id}/unarchive?expectedVersion={version}
DELETE /api/v1/projects/{id}?expectedVersion={version}
GET    /api/v1/projects/{id}/workspace/files?path={relativePath}
GET    /api/v1/projects/{id}/workspace/file?path={relativePath}
POST   /api/v1/projects/workspace-check { daemonNodeId, workspaceHostPath }
```

Creating a project may include an optional absolute `workspaceHostPath` on the
selected Computer to use an existing directory. Omit it or leave it blank to
create the usual `projects/{id}` workspace. Linking requires a live daemon with
`project-links`; the daemon validates the directory against its local
`RELAY_DAEMON_PROJECT_ROOTS` (path-delimited absolute roots, defaulting to the
user's home in direct-run mode and none under BoxLite). Relay's workspace root
and private state cannot overlap the linked directory. Refusals return 422 with
`detail: { code: "project_workspace_<reason>", message }`.
`POST /projects/workspace-check` validates without creating a link and returns
`{ workspaceHostPath }` with the canonical directory path. Linked projects store
that canonical path and a `links/{id}` workspace subpath; both are immutable.
Runs and live file operations require link support, including at command
delivery if a daemon's capabilities change after queueing.

The selected Computer must advertise `project-workspaces`; every enabled member
must be an enabled agent with an active placement on that Computer. A project
may start with an empty roster and `leadAgentId: null`; adding members requires
an enabled lead from that roster. Removing the last member clears the lead.
A project has at most 32 members. Names and function titles are limited to 120
characters, responsibilities to 4,000 characters, and optional project
instructions to 8,000 characters. Updates use optimistic versions; stale writes
return `project_version_conflict`. Duplicate live names return
`project_name_taken`. Existing members that lose readiness may still be edited,
disabled, or removed; adding or reactivating a member and changing the lead
require readiness. Execution validates the selected members again.

A project task with `assignedAgentId` runs only that enabled project member.
Without an explicit assignee it runs the enabled roster, lead first.

Archiving is a soft delete. Archived and disabled projects reject new tasks,
threads, user task mutations, starts, and routine promotion. Schedules do not
advance while the project is closed. Historical tasks, threads, events, and
workspace files remain readable; already admitted runs can finish and record
results. Project settings can re-enable a disabled project or unarchive an
archived project. Unarchiving requires the owner and current `expectedVersion`,
preserves the project's fields and roster, and sets it enabled. A live project
with the same owner and name causes a 409 `project_name_taken` response.
Use `POST /projects/{id}/archive` to archive; `DELETE` now permanently deletes.
Deletion requires the project owner and its current `expectedVersion`, including
for an archived project. It removes the project, roster, tasks (including routines
and occurrences), threads, their event histories and stored artifacts. Links from
other tasks and chat conversation bindings to the deleted threads are removed.
Task prerequisite links, project task-number counters, automation state, webhook
secrets, and queued events for the deleted work are removed in the same database
transaction. Related notifications are cleared from the inbox. Both full and
summary task lists exclude legacy tasks whose project no longer exists, before
applying their limit.
Shared agents and the Computer remain. Normal thread-deletion audit records and
historical usage accounting retain their existing retention policy.

Deletion returns `{ deletedProjectId, workspaceCleanup: "queued", cleanupCommandId }`.
If the owning Computer has an older daemon, deletion succeeds with
`workspaceCleanup: "waiting_for_upgrade"`. Cleanup stays durable and is withheld
from daemons until they advertise `project-workspace-delete`; updating and
reconnecting the Computer completes file removal. A missing Computer registration
returns `409 project_cleanup_unavailable`. Active execution or dispatch claims
return `409 project_execution_active` without deleting any records. Database
records are deleted atomically. Workspace cleanup is durable and runs when that
Computer polls, including after an offline interval; I/O failures or lost
acknowledgements leave the command eligible for retry. Local command storage
additionally refuses delivery if the project still exists after a rollback.
The daemon removes only `projects/{projectId}` and refuses symlink or escaping
roots. Older daemons must be updated before pending files can be removed.

Execution checks include the project's threads and threads linked to its
non-deleted tasks, even when those threads are outside the project. Already-deleted
tasks do not block removal through their retained links. A refusal names blocking
`sessionIds` and `taskIds`; the web UI shows loaded thread names, falling back to
task titles. Deletion also records the owner's assertion for linked executions
that Relay already allows them to report gone, using the normal thread-deletion
reconciliation path. Threads outside the project survive this reconciliation.

Deleting a linked project keeps the existing directory and returns
`workspaceCleanup: "kept", cleanupCommandId: null`. It queues no file deletion
and does not require the Computer to be registered or online. The same active
execution and ownership checks still apply.

Users with active projects cannot be soft-deleted. After all their projects
are archived, user soft deletion is allowed and retains the project history.

Project workspace reads address the persistent shared project root directly;
they do not require a Thread. They are live-only and return
`placement-unavailable` when the bound Computer is offline or lacks
`workspace-read-shared`. `GET /api/v1/workspace/brief?projectId={id}` returns
that project's recent Threads, active tasks, active runs, artifacts, and bound
Computer. `projectId`, `agentId`, and `teamId` brief selectors are mutually
exclusive.

The Agent and Team Activities tabs use `GET /api/v1/workspace/brief?view=activity`
with the same scope selectors. The browser passes `threadLimit=20` to receive
the newest Thread page, active runs, up to ten active Tasks, and a
`nextThreadCursor` when older Threads exist. Requests with `threadCursor`
return only the older Thread page and its next cursor. Thread limits are
clamped to 1–100. Omitting both parameters still returns the complete scoped
Thread list. An unchanged projection returns `304` after the access check
when the request carries its ETag.

Projects and Tasks are separate browser destinations. `/projects` opens the
project directory; `/projects/{id}` opens Dashboard, and `?tab=tasks` opens the
project's Tasks tab with its board/list views. `?tab=automations` lists the
project's automations and creates new ones with that project fixed.
`?tab=automations&automation={automationId}` opens its record within the project;
`&run={runId}` opens an occurrence, and `recordTab` selects the record section.
Closing a record returns to the project list with its filters preserved. Archived
or disabled projects offer no automation creation or dispatch actions. `?task={taskId}` opens a task
record over that project; `recordTab` selects a section of that record.

`/tasks` is a list-only table across projects, grouped by project, status,
assignee, or no grouping (`?group=`). Its queue rail selects `needs_me`,
`untriaged`, `blocked`, `running`, `overdue`, `open` (default), or `done`, or `cancelled`
(`?queue=`). `?project={id}` is a filter, not a separate project workspace.
Deleted tasks and routine templates are excluded; routine runs remain visible.
Archived projects are hidden unless explicitly selected. `/tasks/{taskId}`
opens a record drawer; `?tab=definition` and `?tab=files` select its sections.
Old `/backlog` and `/issues` paths and record/thread deep links continue to resolve.

A task without a project is intake: it cannot receive an agent or team,
become Ready, create a thread, be picked up, or start. These requests return
409 `issue_needs_project`. The scheduler and agent claim paths also hold legacy
projectless work. Routine templates and their `sourceRoutineId` runs are exempt;
clients cannot create a routine run by supplying `sourceRoutineId` to POST.

`PATCH /api/v1/tasks/{id}` with `projectId` moves unstarted intake into an enabled
project owned by the same user and records `task.project_set`. An assignment
may accompany the move. Project Tasks and Automations can select only enabled
Project Agents; a selected Team must consist entirely of enabled Project Agents
on the Project's Computer. Creation, assignment updates, and dispatch enforce
this rule (`project_agent_not_member` / `project_team_not_member`).
Project membership cannot subsequently be cleared or changed. Work with linked
threads, routines, and routine runs cannot be moved. Clearing a legacy intake
assignment is allowed and returns Ready intake to Backlog.

Every task carries `number` and `numberScope`, assigned by the backend (never
accepted on create or PATCH). A project's issues count within the project
(`project:{id}`); a user's other issues (`issue:{userId}`) and their
automations (`automation:{userId}`) count separately. A move into a project
takes that project's next number; numbers are never reused. Clients display
`#{number}` for an issue and `AUTO-{number}` for an automation, and link it to
the record; the `id` stays the key in every URL and request.

Task/thread creation accepts `projectId`. Project dispatch rejects Computer,
team, or non-member overrides; the backend resolves the fixed roster and the
current daemon instance for the project's stable Computer identity.

### Project brief, agent-drafted setup, and context suggestions

A project carries a brief every run in it reads: `description`, a one-line
`goal` (280 characters), and a markdown `context` (8,000 characters) of
standing conventions, constraints, and definition of done. Changing `context`
bumps `contextRevision`. The round's pinned project snapshot carries the brief;
the backend renders it, with the enabled crew, into the agent's `[Project]`
prompt section (`projects/context.py`), and a daemon mirrors it to
`.relay/PROJECT.md` in the project workspace for that run.

```text
GET  /api/v1/projects/{id}/setup   → { setup, candidates }
POST /api/v1/projects/{id}/setup   { intent, agentId?, revise? } → 202 { project, threadId }
```

The create drawer offers a fresh project (a new workspace) or an existing
project (a Linked Directory). Existing projects require a folder and are
configured manually; setup and refinement drafts are unavailable, but plan
drafts (`mode: "plan"`) are not. `POST …/setup` rejects a setup draft for a
linked project with `project_setup_fresh_only` (409).

Setup first creates a project task for drafting, then immediately runs it in a
linked thread. The proposed brief, roster, and work are applied only after
the owner reviews them. The generated name replaces the provisional project name
when drafting finishes, unless the owner renamed it during drafting. A name
collision preserves the provisional name and keeps the proposal for review.
The drafter is any owner agent placed on
that computer (the project-task admission rule), defaulting to the project's
lead, then a planner. `revise: true` drafts again in the same thread from the
last proposal and the owner's note. The run writes
`.relay/project-setup-<runId>.json`; a daemon advertising `project-setup` reports it as
`projectSetup` on `run.completed`, and the backend holds it to the shape the
PATCH accepts (`projects/setup.py`). `project.setup.state` moves
`drafting` → `proposed` or `failed`, then `applied` or `dismissed` through the
PATCH's `setupResolution` — applying is the same PATCH that carries the
accepted name, brief, and roster, so every roster rule runs when it takes
effect. `GET …/setup` marks each proposed member with an `issue`
(`agent_not_found`, `agent_wrong_owner`, `agent_disabled`,
`agent_off_computer`) when Apply would refuse it. Errors:
`project_setup_unsupported` (daemon too old), `project_setup_no_agents`,
`project_setup_in_progress`, `project_setup_not_proposed`,
`project_computer_offline`.

Each draft has a `draftId` pinned in its round manifest. Setup transitions
check the current draft and state inside the project mutation, so a late
result cannot reopen a dismissed setup or replace a newer draft. Definitive
failures before daemon delivery also close the draft as `failed` and delete
its unstarted task. Each revision creates a new drafting task while reusing
the setup thread, and closes the replaced draft's task as `done`; applying or
dismissing a proposal closes its task the same way.

`POST /api/v1/projects/{id}/setup/tasks` creates the selected proposal tasks
with their prerequisites in the backlog. Applying or retrying a proposal
never queues these tasks, including requests from older clients carrying
`queue: true`. The owner starts each task separately through the task controls.

A project run's round result may carry up to three `contextSuggestions`
(`{ text, evidence? }`). They are kept, attributed to their run, on
`project.contextSuggestions` (at most 20 pending, de-duplicated against the
context) and never change the context on their own. A PATCH with
`resolveContextSuggestions: [id…]` removes adopted or dismissed suggestions,
normally alongside the edited `context`.

## Daemon node workspace reads

Generated artifact downloads under
`GET /api/v1/threads/{threadId}/artifacts/{artifactId}` serve the stored daemon
snapshot as an attachment with a restrictive content security policy. The backend
never reads a daemon workspace path from its own filesystem. An artifact without
a content snapshot returns 404; live workspace browsing remains available through
the owning daemon. Older daemons must report generated files and their content to
make new downloadable snapshots available.

The daemon budgets inline snapshots against a 3 MiB serialized completion
payload, including Base64 expansion. Files omitted to meet that budget keep
their metadata with `snapshotSkipped: "too-large"`. If a server returns 413,
the daemon retries the same outcome without inline snapshots or the fallback
transcript. If that is still too large, it retains the durable completion for
retry rather than replacing a successful run with a failure.

The legacy unscoped computer-root file routes return 403 for authenticated
admins. A Computer can contain several Users' private work, so hardware
administration does not authorize browsing its storage root. Open files through
the owning Task, Thread, or Project workspace routes instead.

```text
GET /api/v1/admin/daemon-nodes/{nodeId}/workspace/files
GET /api/v1/admin/daemon-nodes/{nodeId}/workspace/file
```

Default agents a connecting computer offers its signed-in user. An offer lists
a live computer's ready runtimes that have never had an agent there and were
not declined; accepting creates one agent per runtime (named after it, role
`implementer`, placed on the computer), declining is kept with the account's
onboarding choices (`declinedDefaultAgents`). Both take
`{"computerId": "...", "executorKinds": ["claude", ...]}`; a runtime already
answered is skipped, so a repeated accept creates nothing.

```text
GET    /api/v1/agents/default-offers          -> {"offers": [{computerId, computerName, executorKinds}]}
POST   /api/v1/agents/default-offers/accept   -> 201 {"agents": [...]}
POST   /api/v1/agents/default-offers/decline  -> {"ok": true}
```

The signed-in browser uses `GET /api/v1/agents?include=default-offers` to
receive `defaultAgentOffers` alongside `agents`, using the same Computer
inventory and Agent records for both. The standalone offer read also remains
available.

Admin logical-agent and placement management:

```text
GET    /api/v1/admin/agents
POST   /api/v1/admin/agents
GET    /api/v1/admin/agents/{agentId}
PATCH  /api/v1/admin/agents/{agentId}
DELETE /api/v1/admin/agents/{agentId}
GET    /api/v1/admin/agent-placements?agentId=&nodeId=
POST   /api/v1/admin/agents/{agentId}/placements
PATCH  /api/v1/admin/agent-placements/{placementId}
DELETE /api/v1/admin/agent-placements/{placementId}
POST   /api/v1/agent-runs
```

Daemon runtimes renew their backend-advertised liveness lease independently of
command polling:

```text
POST /api/v1/daemon-nodes/{id}/heartbeat
```

The request is authenticated with the daemon node token and may include
`activeCommandLeases` so liveness and delivery ownership renew together.
`leaseSeconds` requests the same command lease used by polling: 1–3600 seconds,
with a 60-second default for older clients. Invalid, nonfinite, or out-of-range
values return 400. Updated daemons send their configured lease on every heartbeat.
An optional `state` of `ready`, `draining`, or `stopped` is accepted (anything
else is 400): `draining` keeps the node online for its running agents but marks
it as no longer taking work, and `stopped` is the graceful exit, replacing the
`stopped` registration for daemons that know the backend accepts it. The
response's `heartbeat` carries `intervalMs`, `timeoutMs`, and `features`
(`poll-liveness`: an open command poll already renews liveness and leases, so
the daemon may skip beats while one is in flight; `state`: the body may carry
`state`). Node records report `online` (a fresh heartbeat) and separately
`dispatchable` (online, and its last command poll is fresh or it has not polled
yet), with `lastSeenAgeMs` and `lastPollAgeMs`; dispatch admits only
dispatchable nodes, so a daemon whose heartbeat works while its poll fails is
never handed work it cannot take.

New computers must enroll before registration. An authenticated admin may also
register a new computer; anonymous registration cannot create an ownerless node.
Event payload validation returns 400, authorization failures return 401, deleted
nodes return 410, and unknown nodes return 404. Unexpected event-processing
failures return 503 for transient database errors and 500 for other ingest
failures. Both are retryable. Durable output and terminal events are retained
in quarantine after permanent 4xx rejection; 408, 429, network errors, and 5xx
responses remain retryable indefinitely.

`GET /api/v1/daemon-nodes/{id}/auth-check` validates the daemon's runtime bearer
token and returns `{ "sandboxId": "<id>", "authenticated": true }`. It does not
register the node, renew liveness, or change its status. Invalid tokens and
unknown/deleted nodes return 401. Doctor and personal-computer setup require
this endpoint; update the backend before distributing the updated daemon client.

`GET /api/v1/daemon-nodes/{id}/commands` returns `commands` plus a `heartbeat`
observation containing `observedAt` and matching `commandLeases`, and
`processingMs` measuring server-side poll processing (including long-poll
waiting). Daemons subtract transport time from each observed remaining lease,
excluding `processingMs` from that transport estimate. An empty successful poll
without matching lease evidence does not confirm execution ownership.
Delivered `run.start` commands are never redelivered solely because their lease
expired. Their original terminal evidence remains valid until settled; cancels
and workspace reads continue to use retryable delivery leases.

For peers advertising `durable-reports`, an unacknowledged delivery is retried
with the same command ID, lease ID, and attempt. An explicit active-command
lease observation acknowledges delivery. `admitRuns=false` suppresses new
starts while still returning cancellation/control commands.

Updated event uploads set `X-Relay-Report-Id` (64 lowercase hex characters) and
`X-Relay-Report-Digest` (SHA-256 of the exact request bytes). A successful
`POST /api/v1/daemon-nodes/{id}/events` echoes both only after effects and the
receipt commit together. Reusing an identity with a different digest returns
409; a missing output predecessor returns retryable 503 with `Retry-After`.
For terminal reports, acceptance commits command exit evidence; workflow
finalization runs after that commit and retries separately if needed.

Apply migration `20261110_0123` before deploying acknowledgement recovery.
Payload-bound receipts are retained independently of command/run/thread history.
An authenticated node can therefore retry an identical accepted report after
history pruning or thread deletion and receive its original acknowledgement
without reapplying effects. Receipt lookup still requires the issuing node,
command/report identity, and exact digest. Only small identity/digest records
persist; retired command payloads continue to follow retention. Downgrading
0123 deletes orphan receipts before restoring the former cascading foreign key.

Terminal reports (`run.completed`, `run.failed`, `run.cancelled`) may include
`lastOutputSequence`, the last captured output sequence still awaiting replay
(`-1` when none remains). With durable receipts, command ownership and run
history are exempt from age/count pruning until the accepted contiguous output
cursor reaches that sequence. Older durable reports without this field remain
protected conservatively, since terminal acceptance alone cannot prove that all
output arrived. Other terminal history continues to follow normal retention.
`run.completed` also preserves a validated `roundResultRejected.reason` when
the daemon found a verdict file but refused it, so the task can explain why.

`POST /api/v1/daemon-nodes/{id}/reports` accepts 1–50 replay records as
`{reports: [{id, digest, body}]}`, where `body` is the exact JSON string whose
bytes were hashed. The response is `{receipts: [{id, digest, status}]}`;
HTTP 200 alone does not acknowledge any individual report. Output sequences
for one run commit as a group; an unexpected group failure rolls them back
and returns individual 500 statuses without starving unrelated groups.

`POST /api/v1/daemon-nodes/{id}/transport` accepts bounded, token-authenticated
transport diagnostics. `GET` on the same path requires the personal Computer's
owner or an admin for shared hardware. Snapshots include queue bytes, pending
and quarantined counts, acknowledged positions, affected run IDs, incident
identity/causes, and whether durable receipts were negotiated. They contain
neither credentials nor raw output. The `computer_transport` notification
updates one incident brief through recovery without resetting read/clear state.
`GET /api/v1/daemon-nodes?view=web` includes a compact `transport` reading
for signed-in owners whose Computer has reported diagnostics. The browser view
carries observation timestamps and liveness flags, so idle age counters do
not invalidate its ETag.

An owner can `POST /api/v1/daemon-nodes/{id}/report-cleanup` with
`{action: "preview"}` to request live counts from a Computer advertising
`report-cleanup`. It returns HTTP 202 with `{commandId}`. Poll
`GET /api/v1/daemon-nodes/{id}/report-cleanup/{commandId}` for its status and
result. A `ready` result includes the retained `pending` count, the
`quarantined` subset and an opaque `revision`. To discard, post
`{action: "discard", scope, revision, acknowledgeOutputLoss: true}`, where
`scope` is `"quarantined"` or `"all"`. Cleanup checks the revision against the
live queue before touching reports. A `discarded` result includes the number
discarded and the remaining counts. If the queue changed, request a new
preview before confirming again. Pending requests expire if they cannot start
within 30 seconds.

Managed-node retry creates an attempt with `replaceActive: true`; draining
patches `desiredState` to `stopped`. `tasks/claim-next` is retired and has no v1
operation.

Resource creation returns `201`. Runs, cancellations, and provisioning that are
queued return `202`. A synchronous deletion returns `200` when it returns a
representation and `204` otherwise.

## Shared skills

Catalog routes require an authenticated user. Visibility is `private` (the
default) or `public`. Private skills can be viewed and used only by their
owner; public skills can be browsed, previewed, downloaded, and assigned by
all signed-in users. Only the publisher can edit, revise, change visibility,
or delete a skill. Each user can grant only to their own Logical Agents.
Changing a publication back to private blocks other users from reading it
and excludes it from their subsequent runs, even with an existing grant.
The retired `org` visibility is migrated to `public` by `20261112_0124`;
`org` assignment targets remain administrator-only delivery scopes.

| Method and path under `/api/v1` | Request / result |
| :- | :- |
| `GET /skills` | `{skills}` with the caller's granted-agent counts |
| `POST /skills` | Metadata plus `files: [{path, contentBase64}]`; returns the created skill |
| `GET /skills/{id}` | Skill, revision history, current file manifest, caller-owned granted agent IDs. Optional `revision_limit` (1–50) bounds the revisions and returns `nextRevisionBefore`. |
| `GET /skills/{id}/revisions?before={revision}&limit=10` | Older revisions below the exclusive revision number, with `nextRevisionBefore` or `null` |
| `PATCH /skills/{id}` | `displayName`, `description`, or `visibility` |
| `DELETE /skills/{id}` | Soft deletion; returns 204 |
| `POST /skills/{id}/revisions` | `files` and optional `note`; creates an immutable revision |
| `POST /skills/import` | GitHub `url`, optional `ref` (HEAD), `subpath`; a directory imports one Skill, empty/omitted discovers all |
| `POST /skills/{id}/import` | Re-import the saved Git source as a new revision |
| `POST /skills/{id}/grants` | `agentIds`, optional `pin`: `"latest"` or `{revisionId}` |
| `DELETE /skills/{id}/grants/{agentId}` | Revoke a grant, including a dangling grant; returns 204 |

Bundles require a root `SKILL.md` with YAML `name` and `description`.
Limits are 300 regular files, 1 MiB per file, and 4 MiB per revision. Paths must
be safe relative paths of at most 512 characters, with components of at most
255 characters. Skill slugs also have a 512-character limit. Invalid input
returns 422; size limits return 413.
Publishing and revision creation return 201.

Imports support public GitHub repositories over HTTPS, without redirects.
Admin organization settings expose `skillImportAllowedHosts`, initially
`["github.com"]`; adding a host does not add another Git provider implementation.
DNS, download, and archive processing share a 30-second deadline.
Links and special files within the selected Skill subpath are rejected; those
outside it are ignored and never followed. Path traversal, multiple archive
roots, and archive size and entry limits are checked across the whole archive.
An empty or omitted `subpath` downloads the archive once and discovers up to
100 Skill directories. Names and descriptions come from each `SKILL.md`;
optional `namespace` and `visibility` apply to every entry. A Skill directory's
nested example manifests remain assets of that Skill, not separate publications.
The response is `{skills: SkillRecord[], failed: [{subpath, code}]}`. Valid
entries are published; invalid bundles and existing owner/name collisions are
reported per directory. The response status is 201 when anything was created,
otherwise 200. No manifests returns 422 `no-skills-found`; over 100 Skills returns
413 `too-many-skills`. Database writes roll back together on infrastructure
failures. Every publication saves its own source subpath for later re-imports.
An explicit `subpath` retains the single-record response. Its name may be
omitted to use the manifest name; a supplied name must match it.
Source directory selectors preserve Unicode and punctuation such as `+` and
`@` across discovery, explicit import, and re-import. Absolute paths, traversal,
backslashes, control characters, and invalid Unicode surrogates are rejected.

Grants resolve at dispatch time. Revocation takes effect on the next run;
running commands keep their captured manifests. Generic agent creation and
patching cannot write `skillPolicy`. Agents that have never used managed grants
retain normal skill discovery. An explicitly managed empty grant set stays
empty for managed delivery.

Daemons advertising `agent-skills` receive a versioned `skills` manifest on
`run.start`. `GET /daemon-nodes/{id}/skill-blobs/{sha256}?commandId=...` requires
the node bearer token and an active dispatched command containing that digest.
Skipped skills produce a persisted `system.notice` in the thread, including
when an older daemon cannot deliver them.

Agent responses merge node inventory with effective managed assignments outside
a Project and legacy direct grants in `skills`. Catalog entries include
`skillId`, `pin`, `available`, and an optional failure `reason`. Scoped entries
also include `assignmentId` and `inherited`; `inherited: true` means the
assignment belongs to a broader scope and must be managed there. Direct Agent
assignments use the assignment revoke endpoint; legacy grants use the grant
revoke endpoint. Direct grants override scoped assignments for the same skill.
Assignments referencing another User's private publication retain only opaque
identifiers and an unavailable reason; the publication's name, namespace,
description, and slug are redacted.

## Cutover Policy

Only the canonical paths documented here are mounted. Relay is under active
development, so unversioned JSON routes, `/sessions`, `/cp`, old action routes,
and hash-based browser URLs do not have compatibility aliases or redirects.

## Task workspace and artifact continuity

```text
GET /api/v1/tasks/{id}/workspace/files?path={relativePath}
GET /api/v1/tasks/{id}/workspace/file?path={relativePath}
GET /api/v1/tasks/{id}/workspace/status
GET /api/v1/tasks/{id}/artifacts?versions=all
```

Task workspace reads use the recorded `workspaceBinding` and current daemon for
its stable Computer. Listings include `workspaceLayout` and `sharedWithProject`.
For Project and Task workspace listings under `.relay/threads`, `view=activity`
combines the requested path with the same path under `.threads` and `threads`.
The response includes `threadRecordsMerged: true` and preserves each entry's
real path. Current entries take precedence on duplicate names. Daemons with
`workspace-list-thread-records` can do this in one command. The backend
merges separate replies for older Daemons or when a merged reply exceeds
the configured event body limit.

The status route returns `{ "waiting": false }`, or `{ "waiting": true }` with
an optional authorized `blockingSessionId` and `blockingTitle`. It never requests
a filesystem scan. All routes use the existing task access policy.

A workspace not yet created returns `409` with `detail.code` and `detail.reason`
set to `workspace-not-created`. An offline Computer returns `503` with
`computer-offline`; missing daemon read/layout capabilities return `503` with
`workspace-unsupported`. Unrecoverable recorded placement returns `503` with
`placement-unavailable`. Access denial remains `403`. An empty directory is a
successful listing with an empty `entries` array, not an unavailable workspace.

The artifact endpoint keeps its latest-per-file default. `versions=all` returns
all recorded versions across the authorized linked sessions/occurrences, newest
first. Artifact downloads prefer retained bytes over live workspace files;
existing size limits and legacy live-file fallback still apply.
Task and automation artifact lists, including `versions=all` and run artifact
counts, exclude internal `HANDOFF.md` and `HANDOFF.json` records under
`.relay/threads/<id>/`, `.threads/<id>/`, and `threads/<id>/`. These continuity
records remain stored on their threads; deliverables with the same names under
an artifacts directory remain visible.

New task runs require a daemon advertising `task-workspaces`. The run admission
records `task.workspace_bound`; conflicting bindings are rejected. Commands with
`reportWorkspaceStatus: true` accept a lease-validated `run.workspace` event with
`waiting: boolean` and optional `blockingSessionId`. These transitions materialize
as `task.workspace_wait` events. Acquiring the workspace queues a clear for the
matching run's wait state. Status delivery retries transient failures while the
run is active. Workspace access and execution proceed during those retries.

### Task flow and acceptance

Task consumers should use `workflowStage` for the board stages (Backlog,
Ready, Queued, In progress, Review, Done, Cancelled) while retaining `status` for execution and waiting
conditions. An execution claim reserves WIP but remains Ready; the task enters In
progress only when the daemon reports that an agent has started. `GET /tasks` and
`GET /tasks?view=summary` also return
`flowPolicy: { wipLimit, scope: "user" }` and
`flowUsage: { userId, occupied }`. The limit is the signed-in user's `maxConcurrentTasks` override, or the server
default of 5 when no override is set. Admin user create/PATCH accepts
`maxConcurrentTasks` (integer 1–100); PATCH null clears it. User responses include
`effectiveMaxConcurrentTasks`. These edits require an administrator.
Usage counts the signed-in user's occupied slots across projects before pagination,
including for administrators. A task entering Review releases its slot. Rework
requires capacity again.

New tasks accept only Backlog/Ready as initial status. `acceptancePolicy` is
`human` (default) or `automatic`; it is immutable once work starts. Successful
human-policy work enters Review, and `PATCH /tasks/{id}` with `status=done`
accepts it. Manual transitions to queued, running, or human waiting return 409; use the
execution endpoint or thread controls. Blocking requires `blockerReason`;
`action=unblock` restores the recorded prior state without pretending to restart
execution. Active task runs and stale state assumptions reject workflow edits.

Task detail and summary projections include `startedAt`, `finishedAt`,
`workflowStage`, and blocker metadata when applicable. New blocked events also
produce an `attention` object: `schemaVersion: 1`, `code`, `source`, `summary`,
`evidence`, `observedAt`, and optional `sessionId`, `runRequestId`, and `runId`.
The explanation is derived only from that event, never an earlier execution's
failure. `blockerReason` remains for compatibility. Unblocking clears both fields.
Historical snapshots may omit `attention`; clients must handle missing fields and
unknown reason codes. `source` is `dispatch`, `execution`, `operator`, or `legacy`;
`evidence` is `recorded` or `unknown`. These are diagnostic fields, not permission
to retry execution. Dispatch can return
`code=task_wip_limit` with `state=queued`; the task has `status=queued` and
`workflowStage=queued`, consumes no WIP, and starts automatically once capacity
opens. `PATCH {"status":"cancelled"}` preserves history and derives `cancelledAt`,
releasing WIP only after execution is settled. Cancelled tasks do not contribute
to delivery metrics; explicitly reopen to Ready to continue them. See [the task lifecycle](guides/task-lifecycle.md) for
transition, capacity, history compatibility, and migration policies.

### Task tool permissions

`POST /tasks` and `PATCH /tasks/{id}` accept `permissionMode` with the value
`ask` (default) or `yolo`. Task records created before this field existed may
omit it. Only the Task owner can opt into YOLO. Each dispatched Agent run
takes the current mode. New Automation occurrences inherit it from the
definition when they are created.

YOLO answers Relay tool Permission Prompts with `allow` and records
`permissionMode: "yolo"` on the Thread's `agent.permission_resolved` event.
Questions still wait for a human answer. Runtime sandbox rules, Connection
Grants, Workflow approval steps, and Task acceptance use their own settings.

### Task review

`GET /tasks/{id}/review` uses the same Task access rule as its detail route.
It returns a derived review of the newest linked Thread: `taskId`, `revision`,
`status`, `canAccept`, `goal`, `description`, `sessionId`, `roundId`, `criteria`,
`reports`, `artifacts`, `verification`, and `missing`.

Reports retain stable run/agent ids, CLI status and exit code, agent-reported
notes/evidence/findings, and output-truncation warnings. For manifested work,
only assignments in the latest round scoped to this Task are included; the
latest attempt supplies each assignment's report. Artifacts retain their exact
ids and source Thread. Continuity records are excluded. Legacy Threads without
manifests have no invented round attribution. A deleted latest Thread is shown
as missing instead of silently falling back to older work.

`verification: "not_recorded"` explicitly means the existing protocol does not
provide independently recorded acceptance-check results. Evidence prose and
successful CLI exit codes are never promoted to verified checks.

Conditional acceptance sends only `{ "status": "done", "reviewRevision":
"<revision displayed to the person>" }` to `PATCH /tasks/{id}`. The backend
locks the Task and source Thread in the write transaction, reconstructs the
review, and refuses a changed revision with `409 task_review_changed`. The
accepted revision is retained on the `task.updated` event. Invalid revisions
and combining conditional acceptance with other edits answer 400. Existing
PATCH clients may still omit `reviewRevision` for compatibility; the task review
controls always supply it. No database migration or new agent execution is
required. This contract binds recorded work, not mutable live workspace files.
Review output links add `?snapshot=1` to the Thread artifact read route. A
missing snapshot answers `404 artifact_snapshot_unavailable`; this mode never
falls back to current workspace bytes. Reads without it keep their existing
live fallback for compatibility.

### Importing GitHub issues

GitHub issue imports default to anonymous public reads, verifying `private: false`
and `visibility: public` before reading issues. An optional `connectionId` selects
the signed-in User’s GitHub Connection for authenticated reads, including private
repositories accessible to that account. Both routes check connection ownership,
provider and availability; credentials remain on the backend. Raw request tokens
and legacy Account connections are never used. Importing does not grant the
created Tasks ongoing access to GitHub.

The legacy Account GitHub App connection is **coming soon**. `GET /api/v1/account/github` (browser login
required) answers `{configured: false, connected: false, comingSoon: true,
login: null, manageUrl: null}`. The authenticated connect and callback endpoints
answer `501 github_connection_coming_soon`, including when App environment settings
are present. `DELETE /api/v1/account/github` remains available for removing
previously saved credentials and pending authorizations.

`POST /api/v1/tasks/github/issues` previews a page of a repository's issues;
`POST /api/v1/tasks/github/import` brings the chosen ones in as `backlog`
tasks. Both take a JSON body:

| Field | Routes | Meaning |
|---|---|---|
| `repository` | both | `owner/name` or a `https://github.com/owner/name[...]` URL |
| `connectionId` | both | Optional owning User’s GitHub Connection; omitted for anonymous public reads |
| `projectId` | both | Destination project; omitted for the caller's intake |
| `state` | preview | `open` (default), `closed`, or `all` |
| `labels` | preview | Comma-separated label filter, as GitHub takes it |
| `page` | preview | 1–100; pages are 50 issues |
| `numbers` | import | 1–50 issue numbers |

The preview answers `{repository, page, hasMore, issues}`; each issue carries
`number`, `title`, `url`, `state`, `labels`, `author`, `comments`,
`createdAt`, `updatedAt`, and `importedTaskId` — the task it already became in
that destination, else `null`. Pull requests are left out.

The import re-reads each issue from GitHub and answers `201` with
`{created, skipped, failed}`: `created` holds the new tasks, `skipped` names
`{number, reason, taskId?}` for `already_imported` and `pull_request`, and
`failed` names `{number, reason}` with a `github_*` code. A rate limit, access
denial, or unreachable GitHub API fails the remaining issues instead of retrying each.

An imported task records `externalSource`
(`{provider: "github", ref: "github:owner/name#12", repository, number, url}`;
`url` is always built from the validated repository). Its title is the
issue's, its description the issue body followed by a link back, and its tags
the issue's labels that are valid tags. `POST /tasks` cannot set
`externalSource`.

A supplied `token` field answers 400 `github_public_repositories_only`; repository
metadata that is private, internal, or not explicitly public answers the same code
with 403 when no Connection is selected. Invalid `connectionId` values answer
400 `github_connection_invalid`; unavailable, missing or unauthorized Connections
use the Connections API error codes and never fall back to anonymous reads. Anonymous GitHub reads of inaccessible repositories answer
`github_not_found`.

Errors are the `detail` codes `github_repository_required`,
`github_repository_invalid`,
`github_issue_numbers_required`, `github_issue_numbers_invalid`,
`github_import_too_large`, `github_state_invalid`, `github_labels_invalid`,
`github_page_invalid` (400); `github_forbidden` (403); `github_not_found`,
`github_issues_disabled` (404); `github_repository_moved` (409);
`github_rate_limited` (429);
`github_unavailable`, `github_unreachable` (502); and `github_timeout` (504).

### Thread execution and deferred deletion

`GET /api/v1/threads/{id}/execution` returns the same `execution` object included
in thread detail and list responses. It reports `phase`, `executionConfirmed`,
`computerOnline` (daemon heartbeat liveness, or null when unknown),
`canDelete`, `blockingReason`, `deletionRequested`, `lastConfirmedAt`,
`queuedAt`, `nextRecoveryAt`, `canRetrySave`, and `canReportGone`. These capabilities
reflect current execution state; operation routes still check actor authorization
and revalidate state. `canReportGone` is false outside `recovery_required` and
when a terminal result is retained for finalization (a finalizing request or a
terminal command, unless its evidence is actually missing); saved evidence must be
recovered rather than discarded. Clients talking to an older backend must at
least gate recovery actions on `recovery_required`. Phases are `queued`,
`starting`, `running`, `stopping`, `unresponsive`, `finalizing`, `terminal`,
and `recovery_required`. A live command lease confirms
execution ownership; task/session outcome alone never proves remote termination.
A fresh computer heartbeat also does not prove execution exit. An online computer
with unconfirmed execution receives process inspection guidance rather than a
connection-loss message.

In the `queued` phase, `queuedAt` uses the current command's creation time and
falls back to the run request's creation time. In other phases, `queuedAt` is null.
For a daemon that reports native startup, `starting` carries `startingRunId`.
The matching runtime's first ready batch carries `runtimeStarted: true` in
`agent.output.batch` and advances the phase to `running`.

`DELETE /api/v1/threads/{id}?stop=true` records an event-backed deletion request
and stops outstanding work. It returns `204` when deleted or `202` with the
execution object while cleanup is pending. Repeating a pending request does not
create another deletion event. Pending deletion prevents new admission and
remains visible in thread responses as `deletionRequestedAt`. The backend resumes
cleanup after restart, without requiring browser polling. It clears conversation
bindings and unlinks tasks before deleting thread history. Tasks, Automation
runs, and Automations are preserved even when their last linked thread is
deleted; their lifecycle and configuration are unchanged. Conversely, deleting
a Task deletes all its linked threads, including shared threads; other Tasks
keep their records and lose those links. Deleting an Automation also deletes
its occurrences and all threads linked to the Automation or its occurrences.
Active execution or dispatch claims reject the deletion with
`409 task_execution_active`; the cascade is atomic. Workspace files are
not removed by this operation. When the execution already requires recovery
(`canReportGone`), the deletion itself is the operator's assertion that the
agent is gone: the backend applies the reconcile transitions and completes the
deletion instead of pending forever. A `finalization_failed` blocker is the
exception — the terminal result is retained and must be saved or explicitly
discarded first.

The existing unqualified DELETE remains synchronous and returns `409` while the
shared lifecycle says deletion is unsafe. All deletion and explicit recovery
endpoints require a human actor with access to the thread; daemon tokens cannot
use them.

`POST /api/v1/threads/{id}/execution/recovery` requests another bounded round of
finalization retries after a `finalization_failed` blocker. It does not clear a
live execution reservation or treat an unreachable computer as stopped. A
`missing_terminal_evidence` blocker with no retained report never offers it (`canRetrySave` is false):
with no evidence to save, a retry only re-marks the evidence lost. It offers
`canReportGone` instead, since a finalizing request was claimed from an exit
report and nothing retained remains to protect.
If a late report restores the evidence, the blocker becomes `finalization_failed`:
retry saving is available again, and reconciliation and deletion cannot discard
the retained result.

A stop intent — an explicit stop or the thread deletion itself, whichever came
first — that stays unconfirmed for 60 seconds surfaces `recovery_required` /
`termination_unconfirmed`, whether the daemon still holds its lease (`stopping`)
or stopped renewing it (`unresponsive`). Silence alone never releases anything.
A disconnected daemon surfaces `unresponsive`; once the delivered command's
lease has been expired for `RELAY_EXECUTION_UNRESPONSIVE_RECOVERY_SECONDS`
(default 600) and the computer is not online, it surfaces `recovery_required` /
`execution_lost`. A daemon that restarts and reports a journaled command it will
not resume surfaces `recovery_required` / `execution_interrupted`: a daemon
advertising `execution-journal-report` sends `journaledCommandIds` on
registration, and the response's `acknowledgedJournalIds` lists those the backend
accounted for so the daemon can drop their journal records. A daemon that cannot
verify a stopped run's process exit for a minute sends `run.exit_unconfirmed`,
which surfaces `recovery_required` / `termination_unconfirmed` at once. Heartbeat
and poll lease observations list `settledCommandIds`: submitted runs that already
have a terminal outcome, so a daemon holding a reported-gone run can give back
its slot. None of these release anything automatically; release still needs a
person's recorded assertion (deletion or reconciliation). A legacy
`orphaned_run` with no run request may be reported gone even when its last command
is terminal, because there is no request left to finalize that result into.

`backend/tests/unit/test_execution_escape.py` walks the whole input space of
the execution status and fails if any overdue deletion has neither a person's
action nor automatic progress; extend its axes when adding a phase or status.

### Thread tool permissions

`PUT /api/v1/threads/{id}/permission-mode` accepts an object with `mode` set
to `ask` or `yolo` and returns the updated Thread. It requires the Thread
owner's signed-in session. The selection is recorded in
`session.permission_mode` with the owner's ID and appears as
`permissionMode` on Thread snapshots and summaries. While a run's command
is active, `execution.permissionMode` reports its effective mode.

An explicit Thread selection overrides the mode inherited at dispatch from
the Task, with `ask` as the default for other runs. The new selection
applies to the current run and subsequent runs in the Thread. Switching to
`yolo` also answers open tool approvals and records the owner's ID on those
decisions. Questions still require an answer, and existing standing grants
continue to apply in Ask mode. The setting governs requests sent through
Relay's Permission Prompt broker.

`GET /tasks?view=summary&threadId={id}` includes
`threadTaskContext.permissionMode`, the Task default for a future
conversational run. A single Task owned by the Thread owner and linked in
the same Project scope can supply this default. Other Threads default to
`ask`. An Automation occurrence can supply its own mode.

`POST /threads/{id}/permission-requests/{requestId}` takes the Thread owner's
signed-in session and returns the updated Thread with its execution status.
The daemon's prompt deadline covers delivery retries and waiting for a decision.
A daemon reads its own prompt through
`GET /daemon-nodes/{sandboxId}/permission-requests/{requestId}?sessionId={id}`.
It can pass `waitSeconds` up to 10 to wait for a decision, with a periodic read
to recover a missed notification. A pending response from a completed long
poll carries `X-Relay-Permission-Wait: 1` so the daemon can reopen the wait
immediately.

## Team responsibilities and work acceptance

### Collaboration styles

Teams accept optional `collaborationStyle`: `build_review`, `pipeline`,
or `lead_led`. Absence defaults to `build_review`; PATCH with `null` clears the
team setting. Tasks and routines accept the same optional field; PATCH with
`""` clears a task override. Routine occurrences inherit their routine's override.

Task dispatch resolves task override → team setting → `build_review`.
Thread messages accept a one-message `style` override and resolve message →
team → `build_review`; task settings do not override messages in their threads.
`POST /agent-runs` also accepts `style` when creating an unaddressed team round,
so a new thread's first message can choose a style. Both routes reject styles
for non-team, addressed-member, discuss, and review requests with
`Collaboration style applies to team work requests only.` Unknown values return
400 and list `build_review, pipeline, lead_led`. Explicit `solo` requests are
rejected. Legacy stored Solo settings resolve to Build → Review for new rounds;
historical snapshots are not rewritten.

The resolved style is frozen in `teamSnapshot.collaborationStyle` and the round
manifest's `style`. A one-member Build → Review round becomes Solo and records
`styleFallbackFrom: "build_review"`. Legacy manifests without `style` remain
Lead-led. Changing settings affects future rounds only. Message retry identity
includes an explicit style; reusing an idempotency key with a changed style is
a different semantic request and is rejected.

Existing teams without a style use Build → Review on their next work request.
Select Lead-led to retain lead planning and final synthesis. See
[ADR-021](adr/021-team-collaboration-styles.md).

### Team computer

A team lives on one computer, like a project's crew. `POST`/`PATCH /teams`
(and the `/admin/teams` variants) accept `computerId`, the stable computer
identity agent creation uses; the team records it and every member must have an
active placement there (`team_member_computer_mismatch`). A computer that is
not the owner's returns `team_computer_forbidden`, one that is unknown or
retired `team_computer_not_found`. A write that names no computer keeps the
team's recorded one, or — for a new or legacy team — takes the single computer
hosting the whole roster, refusing a roster no one computer hosts. Resending an
unchanged roster (a rename, a member's contract) is not a roster change, so
legacy teams saved before this rule stay editable.

### Responsibilities

Team create/update requests accept these optional fields in addition to the
existing name, lead, roster, and enabled fields:

```json
{
  "memberConfigs": {
    "agent-id": {
      "role": "implementer",
      "responsibility": "Own the reset API and its regression tests",
      "participation": "always",
      "required": false,
      "expectedOutputs": ["Endpoint implementation", "Regression tests"]
    }
  },
  "acceptanceCriteria": ["Existing clients remain compatible"]
}
```

Configuration keys must name roster members. Roles use the existing agent-role
vocabulary; `tester` is presented as Verifier in the UI. An omitted role inherits
the agent default. Participation is `always` (eligible for automatic work) or
`on_request` (only when addressed). Regular members are required by default;
explicit membership configuration can make a specialist optional. In Lead-led
rounds the lead coordinates and owns final synthesis. In other styles only the
compiled slots are required. An on-request membership cannot also be
required. Once a proposed plan selects work, that work is required to finish.

Responsibilities are limited to 4000 characters. Criteria and output lists allow
at most 20 nonempty strings of at most 2000 characters. Updates replace the
supplied configuration map; omitted maps remain unchanged. Removing a member
prunes its configuration. The API rejects capability/tool-policy fields in these
configs; roles and work scopes never grant permissions.

Configured teams and multi-member accomplish teams require a daemon advertising
`work-results`. Single-agent action runs also use this contract when the daemon
supports it; older daemons retain the legacy path. Protocol selection is frozen
when the run request is admitted. Its run-bound
`.relay/round-result.json` may contain a `work` object alongside the existing
aggregate `status` and `runId`:

```json
{
  "runId": "current-run-id",
  "status": "continue",
  "work": {
    "status": "continue",
    "evidence": ["Empty input returns 500; expected 400"],
    "findings": [{"workItemId": "implementation-assignment-id", "note": "Validate empty input"}],
    "messages": [{"kind": "handoff", "text": "Reproduction is in the test output"}]
  }
}
```

`work.status` is `done`, `continue`, or `blocked`. `done` requires evidence and
cannot contain unresolved findings. Reports are attributed agent claims. The
backend validates them and records `agent.completed.workResult`; an exit code
alone does not establish work acceptance. Required failures and missing evidence
prevent task completion. Final human acceptance remains independent.

Execution completion and work outcome are separate. `session.completed` carries
an optional `workOutcome`, projected on full threads and thread summaries:
`reported_done`, `unfinished`, `blocked`, `needs_review`, `unverified`, or
`accepted`. `reported_done` is supported by attributed agent reports, not an
independent certificate. `accepted` represents an explicit human thread decision
and does not itself modify a linked task. Historical completion events without
the field replay as `unverified`. New execution clears the previous outcome;
summaries may return `null` while no outcome exists.

A valid `continue` report without unresolved findings can return a task to its
existing bounded continuation queue. Missing reports and required blockers
still need attention. A thread-only run records unfinished work for its next
turn; it does not automatically become a scheduled task.

A coordinator can include `work.plan`, a list of up to 16 items containing only
`agentId`, `objective`, `acceptanceCriteria`, and `expectedOutputs`. The backend
validates the plan against admitted participants and required contributions and
persists an immutable child round before delivery. Clients still submit semantic
messages, not daemon assignments. Two repair cycles and two earlier-teammate
consultations are permitted per request. See
[ADR-019](adr/019-team-work-acceptance.md) for ordering, replay, and compatibility.

## Personal-computer installation

`GET /api/v1/computer-authorizations/setup-command` returns the browser-approved
setup command, which takes no arguments because the served script carries its
own backend origin. It names `RELAY_PUBLIC_WEB_URL` when set, whose host
forwards `/install.sh` to the backend:

```sh
curl -fsSL https://relay.example.com/install.sh | bash
```

The installer starts `POST /api/v1/computer-authorizations` with `workspacePath`,
`displayName`, and `workspaceId` (the stable host identity also reported at daemon
registration). Approval reuses a node only when its owner, host identity, and
workspace match. Two hosts with the same directory path enroll separately;
installers that omit `workspaceId` receive a separate node for each authorization
request. The identity survives browser approval and backend restarts. Approval
can return 409 either because another tab approved the request or because the
computer limit was reached; clients must read the grant status before treating
a conflict as success.

`POST /api/v1/daemon-node-enrollments/local` additionally returns `installCommand`,
the same pipeline with shell-quoted arguments scoped to the enrolled computer
(`… | bash -s -- --sandbox-id … --user-id … --workspace …`). It
contains no token; the installer reads the existing node token from `/dev/tty`.
`daemonCommand` and `daemonEnv` remain available for compatibility.

Both responses also carry `windowsInstallCommand`, the PowerShell twin. Setup is
`irm https://relay.example.com/install.ps1 | iex`; the enrollment form quotes
its arguments (`& ([scriptblock]::Create((irm '…/install.ps1'))) '--sandbox-id' …`)
because PowerShell would otherwise read `--sandbox-id` as a parameter name. It
needs no elevation and prompts for the node token with `Read-Host -AsSecureString`.

Public non-JSON download routes at the backend origin:

- `GET /install.sh`: shell installer pinned to the current client archive
  checksum and to this backend's origin, `Cache-Control: no-store`; 503 if the
  client was not built. `GET /computer/install.sh` serves the same script for
  commands copied before the root path existed.
- `GET /install.ps1` (and `/computer/install.ps1`): the Windows PowerShell
  installer, pinned the same way and served as `text/plain; charset=utf-8` so
  `irm` returns a string.
- `GET /computer/daemon-{sha256}.tar.gz`: compiled client archive, immutable
  caching; 404 if the requested digest is not the deployed release.

These routes serve build artifacts only. All enrollment and execution still
flow through authenticated registry routes and the user's daemon.

Computer credentials are stored as SHA-256 hashes. The compatibility route
`GET /api/v1/daemon-nodes/{id}/token` returns 409 to an authorized owner and
points to reissue. `POST /api/v1/daemon-nodes/{id}/token/reissue` rotates the
credential and displays the new token once, with `installCommand` when supported.
The Token drawer offers reissue for reconnection. BoxLite computers and records
lacking the owner/workspace needed by the installer retain `daemonCommand`;
neither response embeds the token in a command. Browser-approved device setup
issues its credential at the single-use device-token exchange.

A daemon whose registration, poll, or heartbeat receives 401 stops successfully
and asks the owner to run setup again, avoiding service-manager restart loops.
A 410 also stops successfully. Managed daemons save the enrolled sandbox id,
credential, owner, and sandbox mode in a private host state file before starting.
On process restart they reuse that identity instead of redeeming the expired
grant. Bootstrap state is scoped to the backend URL and provisioning grant and
must persist with the daemon host; deleting it requires a new provisioning grant.

The global Threads list includes standalone conversations, Task threads, and
Automation run threads across all Projects. Project conversations use
`/projects/{projectId}/threads/{threadId}` and display the same global thread list;
new Project conversations use `/projects/{projectId}/new`. Both select Threads
in the sidebar. The conversation's mobile Back control returns to Threads.

The Projects sidebar link opens `/projects` with the Project directory;
`/projects/{projectId}` shows the Project overview. Neither displays thread rows
in place of the Project directory. Existing nested Task conversation links
resolve to the conversation's Project or Computer workspace and share the same
conversation and access to its owning Task.

## Administrator user roster

`GET /api/v1/admin/users?view=web` returns 25 users at a time, the Computer
labels and presence for those rows, the requested page clamped to the filtered
total, and account-wide counts for the status filters. Pass `page`, `filter`,
`sort` and `q` to change the window. Search matches the user's name, email,
department, id, and assigned Computer names or ids across the entire roster.
The response carries an ETag and is held in the admin's in-memory query cache.
`GET /api/v1/admin/users` without the view retains the complete roster.

## Sign-in and account email

Every new Account carries a sign-in email: bootstrap, admin creation
(`POST /admin/accounts`, `POST /admin/users`), invite acceptance (the invite's
own address), and `python -m relay.init_users` (`--email` or
`RELAY_INITIAL_ADMIN_EMAIL`). An address is trimmed and lowercased, must look
like `local@domain.tld`, and belongs to one Account in any letter case (the
`uq_auth_accounts_email_lower` index). Accounts created before email was
required may have none and keep signing in by username. Rules:
`backend/relay/core/email_address.py`, `backend/relay/security/account_identity.py`.

| Method and path | Auth | Answer |
| :- | :- | :- |
| `POST /auth/bootstrap` | admin token in body | Body `{token, username, email, password}`. Creates the first admin and signs in. `400` missing/invalid email or weak password, `409` accounts already exist |
| `POST /auth/login` | none | Body `{username, password}`; `username` takes a username **or** an email (case and surrounding spaces ignored). An identifier two Accounts answer to (a legacy username equal to another Account's email) signs in neither. `401 "Invalid username or password."` for every failure, `429` rate limited |
| `POST /admin/accounts` | admin | Body `{username, email, password, role?, …}`. `400` invalid input, `409` `"username already exists."` or `"An account with this email already exists."` |
| `POST /admin/users` | admin | Body `{userId, username, email, password, …}`. `400` missing/invalid email, `409` handle, username, or email taken |
| `PATCH /admin/users/{id}` | admin | `email` on a User who signs in must be a valid, unused address and moves the Account's sign-in email and reset recipient with it; it cannot be cleared. `409` email taken |

A username may not equal another Account's email and vice versa, so one
identifier never names two Accounts. Before migrating, run
`relay audit-account-emails` (read-only): migration `20261113_0126` refuses to
add the index while two Accounts share an address and names their ids, and
logs the non-blocking findings (ambiguous identifiers, malformed or
unnormalized emails, Account/User email differences, Accounts without email).

## Waitlist

Only the public join is gated: `POST /waitlist` is mounted when
`RELAY_WAITLIST_ENABLED=1`, which `GET /api/v1/auth/status` reports as
`waitlistEnabled` and `GET /api/v1/admin/settings` as `capabilities.waitlist`.
The invite routes and the admin queue are always mounted. Invites are links
by default: the admin hands the link over and `delivery` is `null`. Email
requires `RELAY_WAITLIST_INVITE_EMAIL=1`, a configured mailer, and a public web
URL (`RELAY_PUBLIC_WEB_URL`, else `RELAY_PUBLIC_BACKEND_URL`) —
`capabilities.inviteEmail`. With invite email enabled and a configured mailer,
an unconfigured public origin produces `delivery.status: "skipped"`.
Rules and rationale: `docs/guides/accounts.md`.

| Method and path | Auth | Answer |
| :- | :- | :- |
| `POST /waitlist` | none | `202 {"ok": true}` for every valid body — new, known, declined, or honeypot (`website` non-empty). `400` malformed, `429` rate limited, `503` queue full |
| `POST /waitlist/invites/lookup` | none | Body `{token}`. `{invite: {email, name, suggestedHandle, expiresAt}}`; every dead token is one `404` |
| `POST /waitlist/invites/accept` | none | Body `{token, handle, password}`. Creates the account, sets the session cookie, returns `{user}`. `400` weak password or bad handle, `409` handle taken or `"An account with this email already exists."` (the invited address is now used by another Account), `404` dead invite; a refused accept leaves the invite live |
| `GET /admin/waitlist?status=&q=&limit=&offset=` | admin | `{entries, total, counts}`, oldest first |
| `GET /admin/waitlist/queue?q=&limit=&waiting=&invited=&joined=&declined=` | admin | `{bands: {waiting, invited, joined, declined}}`. Each band has `{entries, total}` after applying the search, oldest first. The four optional status parameters are zero-based offsets. `limit` is the page size per band (1–200) |
| `POST /admin/waitlist/{id}/invite` | admin | Rotates the token and returns its link. `{entry, inviteUrl, delivery: null \| {status, error}}`; `inviteUrl` is the only time the token appears |
| `POST /admin/waitlist/invitations` | admin | Body `{email, name?, locale?}` (`en`/`zh-CN`/`zh-TW`). Invites an address directly, reusing its entry if it asked (source `admin-invite` otherwise) and ignoring the queue cap; emailed now only when invite email is enabled. `{entry, inviteUrl, delivery}`. `400` malformed, `409` a live account already uses the email, or the entry joined and its account still exists (a deleted user's entry is reopened and re-invited) |
| `POST /admin/waitlist/invite-batch` | admin | Body `{count}` (1–50, oldest waiting first) or `{ids}`. `{invites: [...]}` with `delivery: null` by default. When email is enabled, emailable invites have `delivery.status: "queued"`; the emails go out after the response, so the links survive a slow mail service. A queued email whose entry was re-invited, declined, accepted, or erased meanwhile is not sent |
| `POST /admin/waitlist/{id}/decline` | admin | `{entry}`; clears any live invite |
| `PATCH /admin/waitlist/{id}` | admin | Body `{adminNote}`. `{entry}` |
| `DELETE /admin/waitlist/{id}` | admin | Erases the entry (an account it created is untouched) |

Invite links carry the token in the URL fragment (`/join#token=…`), and the
page sends it to the API only in a POST body, so no server or edge access log
records a redeemable token. `delivery` is `null` when invite email is disabled
or no mailer is configured. Otherwise `delivery.status` is `queued`, `sent`,
`bounced`, `failed`, or `skipped` (no public origin); it never changes the
entry's status.

## Password Reset

Asking for a link needs email and a configured public origin:
`POST /auth/password-reset` answers `404` unless `RELAY_MAIL_*` and
`RELAY_PUBLIC_WEB_URL` (or `RELAY_PUBLIC_BACKEND_URL`) are set — an emailed link
is never built from the request's `Host` — and `GET /api/v1/auth/status` reports it as
`passwordResetEnabled`. Redeeming a link does not, so an admin-issued link
works on an install without mail. Rules and rationale:
`docs/guides/accounts.md`.

| Method and path | Auth | Answer |
| :- | :- | :- |
| `POST /auth/password-reset` | none | Body `{identifier, locale?}` — a username or an email. `202 {"ok": true}` whether or not an account matched; the lookup and email run after the response. `400` malformed, `429` rate limited (per IP) |
| `POST /auth/password-reset/lookup` | none | Body `{token}`. `{reset: {username, expiresAt}}`; every dead token is one `404` |
| `POST /auth/password-reset/complete` | none | Body `{token, password}`. Sets the password, deletes every session of the account, emails a "password changed" notice, and returns `{ok, username}` without signing in. `400` refused password (the link stays live), `404` dead link |
| `POST /admin/users/{id}/password-reset` | admin | Issues a link for the user's account, bypassing the request throttle, and emails it when mail and an address exist. `{url, expiresAt, delivery}`; `delivery` is `sent`, `bounced`, `failed`, or `skipped` |

Reset links carry the token in the URL fragment (`/reset-password#token=…`) and
the page sends it only in a POST body. A link expires after
`RELAY_PASSWORD_RESET_TTL_MINUTES` (default 30); one account is sent at most
one link per `RELAY_PASSWORD_RESET_COOLDOWN_SECONDS` (default 60) and
`RELAY_PASSWORD_RESET_MAX_PER_HOUR` (default 5).

### Personal account settings

`PATCH /api/v1/auth/profile` accepts `{ "displayName": "Ada Lovelace" }` for
only the signed-in user's linked profile. The trimmed name must contain 1–100
characters. It returns `{ "user": ... }` with the same decorated account shape
as `/auth/me`.

`POST /api/v1/auth/password` accepts `currentPassword` and `newPassword` for
only the signed-in account. It requires the current password, applies the shared
password policy, and rejects an unchanged password. Success returns
`{ "ok": true }`, invalidates outstanding password reset links, and revokes all
other login sessions while keeping the calling session. Attempts are rate
limited. Both endpoints require a session cookie; invalid values return 400.
The browser exposes both forms at `/settings/account`.

### Notification inbox

`GET /api/v1/notifications?view=count` returns `{unreadCount}` for the
signed-in Account. It counts unread, uncleared notices outside the Account's
muted kinds. With the inbox closed, the web client polls that count and loads
the notice list on opening. Desktop notifications keep the list poll active
when enabled and granted by the browser. The list stays `no-store` and
supports `If-None-Match` for revalidation with an in-memory copy.

### Personal tag catalog

A person's tags are the names they saved plus every tag on the live Tasks and
Automations they own — the records `GET /api/v1/tasks` lists, counted in full,
never one page. Names follow the per-record rules (`core/task_tags.py`: trimmed,
inner whitespace collapsed, 1–32 characters, no comma; identity is
case-insensitive). Saved names live in `user_tags`; tags on work stay in the
task snapshots and change only through new `task.updated` events carrying
`tags`, `actorUserId`, and `tagOperation` (`rename` / `merge` / `delete`).
Earlier events are never rewritten. Status, assignment, and schedules do not
change, and nothing is dispatched. Only a sign-in session may call these routes
(no node or chat-service token); anonymous calls answer 401. Errors are
`{ "detail": "<code>" }`. Rules: `backend/relay/tags/catalog.py`.

```ts
type TagEntry = { name: string; taskCount: number; automationCount: number; saved: boolean };
type TagOperation =
  | { operation: "rename"; name: string; newName: string }
  | { operation: "merge"; sources: string[]; target: string } // 1–20 sources
  | { operation: "delete"; name: string };
type TagRecord = {
  id: string; number: number | null; title: string; isRoutine: boolean;
  tagsBefore: string[]; tagsAfter: string[];
};
type TagRecordGroup<T> = {
  taskCount: number; automationCount: number; // complete counts
  items: T[]; itemsTruncated: boolean;        // at most 50 items
};
type ExcludedReason = "project_unavailable" | "project_not_owned" | "project_disabled";
```

- `GET /account/tags?query=` → `{ tags: TagEntry[], total }`, sorted by name,
  `Cache-Control: no-store`. `query` keeps names containing it,
  case-insensitively. A tag shows its saved spelling, else the spelling its
  records use most. `saved: false` means the tag exists only on work.
- `POST /account/tags` `{ name }` → 201 `{ tag: TagEntry }`. 400 `tag_invalid`;
  409 `tag_exists` (saved, or already on any of your work, in any case); 409
  `tag_catalog_full` (500 saved names).
- `POST /account/tags/preview` `TagOperation` → `{ operation, previewToken,
  affected: TagRecordGroup<TagRecord>, excluded: TagRecordGroup<TagRecord &
  { reason: ExcludedReason }>, catalog: { removes: string[], saves: string |
  null } }`. 400 `tag_invalid` / `tag_operation_invalid` / `tag_unchanged`; 404
  `tag_not_found` (the source is in neither your saved names nor your work);
  409 `tag_exists` (a rename onto a different existing tag — offer merge
  instead; renaming only the letter case is allowed).
- `POST /account/tags/apply` `TagOperation & { previewToken }` → `{ operation,
  updated: { taskCount, automationCount }, excluded: { taskCount,
  automationCount }, tags: TagEntry[] }`. 400 `tag_preview_required` or a
  validation code; 409 `tag_preview_stale`. Re-preview and confirm again.

Scope and exclusions: a record in a project is changed only while the project
is yours, unarchived, and enabled (the task PATCH rule). Other records are
listed under `excluded` with a reason and left unchanged. The reason carries no
project details, and the tag stays listed through those records. Delete removes
the tag from affected records and drops the saved name; it never deletes a Task
or Automation. Merge replaces every source with the target at the first
position any of them held, removing duplicates. Rename and merge also save the
new name. An Automation's next occurrences inherit its updated tags; earlier
occurrences are ordinary Tasks and are covered by the same operation.

Concurrency: `previewToken` fingerprints the affected records (id, version,
outcome), the excluded ones, and your saved names. Apply takes a per-user lock,
holds the matching rows for update, recomputes the preview, and answers 409
`tag_preview_stale` on any difference. That covers a new or edited record, a
project change, a concurrent apply (exactly one wins), and a reused token. So a
preview never authorizes records it did not show. All record events and the
catalog change commit in one transaction or none do. A task saved afterwards
from a client that still holds the old tags writes them back; the tag then
reappears as an unsaved tag.

Cache: after create, invalidate the catalog query (or insert the returned
`tag`). After apply, replace the catalog with the returned `tags`, and
invalidate task and automation lists and any open task detail or tag picker
caches, because record versions and tags changed.

### Thread image attachments

- `POST /api/v1/thread-attachments`: authenticated raw image upload, with
  `Content-Type: image/png`, `image/jpeg`, or `image/webp`; maximum 10 MiB.
  Returns `201` with `{id, mediaType, bytes, sha256}`. Uploads are private and
  staged for their uploading User until admitted to a Thread.
- `GET /api/v1/thread-attachments/{id}`: image bytes, authorized for the uploading
  User while staged and by Thread access after admission. Responses are private,
  non-cacheable, and carry `X-Content-Type-Options: nosniff`.
- `POST /api/v1/threads/{id}/messages` and `POST /api/v1/agent-runs` accept
  `attachmentIds` (up to four UUIDs). The message event stores metadata only;
  the opening message stores it on `session.created`. A message with images may
  omit text; new `/agent-runs` requests still require `taskGoal`.
- `GET /api/v1/daemon-nodes/{node}/attachments/{id}?commandId={command}`:
  daemon-token authentication plus a dispatched `run.start` command belonging
  to this node and naming this image. Browser credentials alone do not grant
  daemon download access.

`run.start.attachments` contains the same immutable metadata, never image bytes,
R2 credentials, or expiring URLs. The daemon verifies size and SHA-256, writes
private temporary files within the mounted workspace, and removes them after
execution, including failures. Codex receives native image inputs (including its
app-server adapter); Claude receives structured image blocks on stdin. Other
runtimes are refused explicitly. The Computer must advertise `image-attachments`;
the configured model must support image input. The most recent image-bearing
message remains visual context for subsequent turns and recovery.

Hosted installs reuse `RELAY_BLOB_STORE=r2`; without it, bytes remain in the
existing database-backed deployment mode. Apply Alembic revision `20261103_0109`
before starting the new backend and rebuild the Computer bundle. Thread deletion
removes bound upload rows and schedules R2 object deletion after commit. Each
upload also prunes up to 100 abandoned uploads older than 24 hours; a quiet
installation retains them until the next upload. Object deletion is best effort,
so failed deletions require storage maintenance. Uploads use the existing
per-process auth rate limiter with a separate per-User key.

## Service Connections

The provider-neutral Connections API is separate from the legacy Account GitHub
App API. It authenticates external identities for use in Threads, Tasks, and
Automations. GitHub issue imports may explicitly select an owning User’s
Connection for private repository reads, and otherwise remain anonymous.

`GET /api/v1/connection-providers` returns deployment availability and supported
actions. `GET /api/v1/connections` returns only the signed-in User's redacted
identities. `POST /api/v1/connections/authorizations` accepts `provider`, a safe
local `returnTo`, and optionally `reconnectId`. The browser follows its `url`;
the provider callback validates the initiating session and single-use state.
Gmail and Outlook callbacks append a `connectionResult` to the validated return
URL and include `connectionResultId` on success. Fetch the Connection list to
confirm the connected identity.

Work access is read and replaced through
`/api/v1/connection-grants/{thread|task|automation}/{id}` (GET/PUT). A PUT body
contains `grants`, each naming `connectionId`, `resources`, and `actions`.
Preserve returned `id`/`revision` pairs when editing; stale pairs answer 409.
Task create/PATCH and new `/api/v1/agent-runs` requests also accept
`connectionGrants`, saved before dispatch. Linked Threads use Task access;
generated Automation Tasks expose read-only access snapshots.

Permission edits replace the previous Grant identity. Existing run snapshots
cannot recover a removed permission when it is added back later. Disconnect
removes saved credentials and pauses dependent active Automations without
claiming that an executing agent has exited. Run-scoped MCP calls use
`POST /api/v1/connection-tools`; browser sessions cannot authorize those calls.

Gmail and Outlook expose the `inbox` resource and provider-prefixed
`list_messages` and `get_message` actions. The body-read action requires the
list action in the same Grant. Lists accept optional `unreadOnly`,
`receivedAfter` (RFC 3339), `limit` (1–25, default 20), and `cursor`. Reuse the
same filters with `nextCursor`. `get_message` takes a `messageId` from the same
run's list result and returns a plain-text body capped at 16 KiB with a
`truncated` flag. Message references and cursors expire after 15 minutes.

See [Connections](guides/connections.md) for all routes, resource pagination, provider
configuration, supported runtime adapters, and deployment verification limits.

## Project Lead management

The Project Lead selected by `leadAgentId` holds management responsibility
beside its execution role. Legacy `managerAgentId` and member `projectManager`
fields are derived aliases of that lead, including on existing Projects.
A legacy `role: "project_manager"` still upgrades to `role: "planner"`, but does
not override the lead. These routes require the Project Owner; admin status
and daemon credentials do not confer owner authority. Wire names remain
unchanged for compatibility.

- `GET /api/v1/projects/{id}/manager` returns the binding, eligible candidates,
  availability reason, the historical shared Thread ID if present, and recent proposal cards. Reading
  writes nothing: it never assigns the role and creates no Thread or run.
  Archived history remains readable.
- `PUT /api/v1/projects/{id}/manager` accepts `agentId` and `expectedVersion`
  and changes `leadAgentId`; every member keeps its execution role. An Agent
  outside the roster joins with its default role. Project creation accepts
  legacy `managerAgentId` as a lead choice; omitted or `null`, the supplied
  lead holds management responsibility.
- `POST /api/v1/projects/{id}/manager/conversation` creates a new Project
  Conversation on each request and returns `threadId` and `agentId`. The current
  Project Lead joins as its first Agent participant. The Thread snapshot and
  summary carry `projectLeadDiscussion: true`. Messages without an explicit
  recipient go to the current Lead when dispatched.
- `GET /api/v1/projects/{id}/manager/overview` returns live Project context,
  complete task counts, recent tasks, capacity, and retrieval coverage.
- `GET /api/v1/projects/{id}/manager/proposals?threadId={threadId}` returns the
  most recent 50 proposals scoped to the owner's requested Project Thread.
- `POST /api/v1/projects/{id}/manager/proposals/{proposalId}/apply` accepts an
  `idempotencyKey`, optional `expectedRevision`, optional `operationIds`, and an
  optional `fields` map keyed by operation ID. It atomically applies selected
  edits through ordinary task operations. A stale Task or invalid prerequisite
  rejects the whole batch. Retrying an identical application key and payload
  returns the recorded result; reusing the key for a different payload conflicts.
- `POST /api/v1/projects/{id}/manager/proposals/{proposalId}/dismiss` settles a
  pending proposal without changing tasks.

New tasks stay in backlog. Applying changes does not start work, accept review,
answer a Wait, or reconcile execution. Disabled and archived Projects refuse
new manager work and proposal applications.

`POST /api/v1/daemon-nodes/{id}/project-manager/tools` remains a compatibility
adapter. It requires node authentication plus the currently dispatched command
and lease, and validates the pinned manager Project/Agent run context rather than
a canonical Thread ID. New daemons route both native MCP and isolated host/guest
calls through the MCP bearer-token API using a command-bound token held in daemon
memory. Both MCP paths expose scoped reads, Task/Automation management and proposal
staging, never owner Apply. The legacy JSON adapter retains its read/proposal
operations. See the [Project Manager guide](guides/project-manager.md)
for runtime installation and rollout requirements.


### Relay MCP bearer-token API

`POST /api/v1/mcp/tokens` (owner session) accepts `{name, projectIds?}` and returns
`{id, token, ...metadata}` once, with `Cache-Control: no-store`. All Projects
must belong to the caller. Explicit Project lists grant read-only Project access;
omitting `projectIds` also enables standalone Task/Automation management and reads
of owned Projects. Neither form grants Project Lead authority. Tokens expire after 90 days. `GET /mcp/tokens` lists
metadata only; `DELETE /mcp/tokens/{id}` revokes the owner's token.

`POST /api/v1/daemon-nodes/{id}/mcp-token` uses the enrolled Computer credential
and returns a separate MCP token scoped to its owner and Computer. Optional
`{commandId, leaseId}` binds it to an active command, including standalone runs;
authentication stops when that run ends. Each issued run token lasts at most
24 hours; the daemon refreshes near expiry using the same active command/lease
scope. Concurrent requests share one refresh. HTTP 401 clears the refused token
for the next explicit call, but the refused request is never replayed automatically.
Every run may manage
the owner's standalone Tasks and Automations. Project reads require the admitted
Project's enabled roster identity. Writes and Task execution controls require
its current Project Lead. `tools/list` omits `relay_propose_task_changes`,
`relay_start_task` and `relay_stop_task` for readers, while still exposing
standalone mutation tools. Unauthorized Project writes return a tool error
`project_manager_required`; omitting `projectId` never bypasses stored resource scope.

`POST /api/v1/mcp` is the canonical MCP Streamable HTTP endpoint, hosted by
`backend/relay/mcp/` using the official Python SDK. It supports initialization,
notifications, `tools/list` and `tools/call` with stateless JSON responses. The
Python catalog defines Project reads, Task/Automation CRUD, Task execution controls, review
and Task proposal tools. The local Node
stdio bridge forwards messages unchanged. No separate MCP deployment is needed.
The SDK endpoint is registered directly as an ASGI route and is not enumerated
in FastAPI's generated OpenAPI schema. Its catalog and schemas are discovered
through MCP `tools/list`.

`relay_start_task` accepts `taskId` and optional `projectId` from a current Lead
run. It uses the Task's saved assignment and the ordinary Task dispatch path,
including prerequisites, capacity and Workflow approval gates. The response
includes `task`, `dispatch` and a nullable `threadId`.

`relay_stop_task` accepts `taskId`, optional `projectId` and optional `reason`.
It keeps the Task and its assignment and asks the daemon to stop any active
execution. The response includes `task`, a nullable `threadId` and `outcome`
of `idle`, `stop_requested` or `settled`.

This endpoint is separate from Service Connections' `/api/v1/connection-tools`;
its MCP tokens do not authorize external-provider calls. See the
[implemented tool architecture](system-architecture.md#41-implemented-mcp-boundaries).

Every request requires `Authorization: Bearer <MCP token>`; browser cookies alone
are refused. All responses are `no-store`, untrusted browser Origins are refused,
and each concurrent request has its own grant. Requests are limited to 128 KiB;
serialized tool results are limited to 1 MiB. Authenticated GET/DELETE return 405
(`Allow: POST`); there is no resumable session or server event stream.

Older JSON clients and workspace helpers retain these compatibility routes,
which delegate to the same Python authorization and operations:

| Route | Behavior |
| --- | --- |
| `GET /api/v1/mcp/projects` | List only Projects in token scope. |
| `POST /api/v1/mcp/projects/{id}/tools` | `{tool, arguments}` for overview, tasks, task, review, activity, threads, thread, workspace metadata, or propose. Scope and ownership checked on every call. |
| `POST /api/v1/projects/{id}/manager/conversation` | Owner session: create a new Project Conversation without dispatching a run. |

`propose` accepts `arguments.operations` with the same validated operation format
as manager proposals. Direct MCP proposals have `source: "mcp"`, token provenance
and the Project Lead's actual run ID. They remain pending until the owner applies them with
a browser session. MCP bearer tokens cannot use owner mutation endpoints.


### MCP renewal and manager handover

An enrolled Computer can check its standalone MCP credential with
`POST /daemon-nodes/{id}/mcp-token` and `{existingToken}`. Healthy grants return
metadata and `renewed: false`, with no plaintext token. Within seven days of
expiry, or after expiry, the backend atomically revokes the old credential and
returns its replacement once with `renewed: true`. Revoked/unknown grants return
403 and cannot be renewed. Renewal cannot be combined with a command scope.

Manager reassignment, whether through PUT manager or PATCH Project members,
changes only the roster. It writes nothing to any Thread: the manager Thread
keeps its participants and history, and the former holder stays an ordinary
Agent that may still be addressed there. Every round in a Project — Task
run, Automation occurrence, Thread message, or continuation — resolves manager
capability from its pinned roster, for the holder's assignment only, alone or
beside other Agents; proposals keep their own Thread/run identity. A computer without `project-manager-mcp` still runs the holder,
without the tools, and the manager view reports
`project_manager_update_required`. Older Threads may carry the retired
`thread.project_manager_assigned` event; it still replays.


Thread follow-up queues are database-backed `session.queue` events. The owner
may `enqueue` text with a stable message `id`, `remove`, `edit` (take the message
back into a local draft), `promote` a message to send next, `steer` to send a
message to the running agent now, `pause`, or `resume`.
`import` accepts legacy browser messages in a paused queue. The response is
`{ messages: [{ id, text, addressAgentIds? }], paused, sending?, live?, error? }`.

`steer` first hands the message to the live run when the run's Computer
advertises `live-messages` and the message is for the agent that is working (not
a team or another agent): the queue records `live: { id, commandId, until }`,
holds the message from edits and other sends, and queues a `run.steer` command.
The Computer's `run.steered` answer settles it — `delivered` removes the message
from the queue and appends a `user.live_message` event (shown in the transcript
as the person's message, marked as sent while the agent worked; it is not a new
user turn, but later runs see it in their conversation history); `unavailable`
or `failed` falls back to stopping the run and sending the message next. A
message with no answer before `until` (two minutes) is sent after the run like
any other queued follow-up. Otherwise `steer` stops the current execution and
sends the message next.
Enqueue retries use durable receipts, including after a message has been sent.
There are at most 20 messages, each at most 100,000 characters. Leading mentions
resolve when enqueued; runtime placement and authorization are checked again
at dispatch. Editing a message another client already took returns 409.

The existing task scheduler dispatches one queued message per thread per tick,
through ordinary collaboration admission. It requires confirmed execution exit
and holds automatic dispatch while the thread needs human input. Failed
admission retains the message and pauses the queue. An interrupted dispatch
retries with the same idempotency key after a five-minute claim lease. A
`steer` request holds the queue until the stop is recorded. The chosen message
then waits for confirmed exit. An execution that never reached a Computer is
cancelled immediately. Explicit `promote` and `steer` requests have a short-lived
dispatcher that checks for exit between scheduler ticks. Disabling
`RELAY_TASK_SCHEDULER_ENABLED` disables the regular sweep. Cancellations pause
the queue by default. Clients may pass `preserveQueue: true` to keep its state.

### Legacy Project Team workflow definitions

These Team fields/routes remain compatibility adapters. New clients use the
independent Project Workflow endpoints documented below.

`POST /api/v1/teams` and `PATCH /api/v1/teams/{id}` (including admin
variants) accept the opt-in contract below. Responses and Team events preserve
these fields. Legacy Teams omit both fields and keep their existing behavior.

| Field | Type and validation |
| --- | --- |
| `projectId` | Nonempty string, at most 128 characters; live enabled Project owned by the Team owner. Once set it cannot be removed, cleared or changed. |
| `workflowSteps` | Ordered array of 1–64 steps; required with `projectId`. Replacing it changes the saved order. It cannot be cleared to restore legacy execution. |
| step `id` | Client-assigned stable string, 1–64 ASCII letters, digits, `_` or `-`; unique within the workflow. Preserve it when editing/reordering a step. |
| step `name` | Nonempty string, at most 200 characters; free text, not an Agent role. |
| step `agentId` | Nonempty string, at most 128 characters; one pinned Team member. Repeated assignees across steps are allowed. |
| step `instructions` | Nonempty string, at most 8,000 characters. |
| step `expectedOutputs` | Deprecated compatibility field; omitted for new steps. Existing frozen runs retain their saved output requirements. |
| step `acceptanceCriteria` | Required array of 1–32 nonempty strings, each at most 2,000 characters. Instructions, not proof of success. |
| step `kind` | Deprecated compatibility metadata (`work` or `deployment`); omitted for new steps. Steps have no predefined type. |
| step `requiresApproval` | Boolean; defaults to `false` for every step, independently of legacy `kind` metadata. This records future per-attempt gates; W1 cannot approve or execute them. |

Text is trimmed before persistence. Unknown step fields and unknown workflow
Team write fields are rejected. Both fields must be supplied when opting an
existing legacy Team into workflow mode. A workflow cannot also specify a
non-null `collaborationStyle` or enable the legacy `humanApproval` policy;
clear those legacy settings explicitly during conversion. A workflow is not a
Pipeline and never falls back to role ordering.

Every create/update rechecks all members, including unchanged rosters: each
must be a live enabled Agent owned by the owner, an enabled Project Agent,
and actively placed on the Project's Computer. `computerId` must match that
Computer (inferred on creation when omitted). Rejected writes leave the Team
snapshot and event sequence unchanged. Agent removal can retain historical
step assignees; a subsequent definition save must repair the invalid roster.

Only the Project owner's signed-in user session can create, update or delete
these definitions. Administrator status, admin bearer tokens, chat service
credentials and Computer credentials confer no workflow management authority.
The admin routes apply the same owner rule. The owner can delete an invalid or
archived Project's Team without restoring its roster first.

No database migration is required: the fields live in existing Team snapshots
and authoritative `team.created`/`team.updated` events. Names remain unique per
owner, as with legacy Teams. Project manager Team lists exclude workflows
belonging to other Projects on the same Computer.

The internal Python session reducer additionally recognizes `workflow.started`
and `workflow.gate_decided` for a frozen run and revision-bound gate ledger.
`POST /api/v1/teams/{teamId}/workflow-runs` starts a frozen first attempt;
`/workflow-gates` is an alias. The body contains exactly `requestId` (UUID string)
and `taskGoal` (nonblank text, at most 20,000 characters). The Project owner's
login session and an enabled workflow Team are required. Live Project, roster,
Placement and Computer checks precede admission.

The server atomically creates a Project-scoped Thread, `workflow.started`, and
a durable prepared request bound to the frozen assignments. A pending first-step
gate creates no daemon command or execution reservation. An ungated first step
publishes one `run.start` through the existing daemon queue. Publication and
request linkage share the database transaction; a refused start leaves no Thread.
Success returns the Thread snapshot (201). Unknown fields/invalid input return
400; invalid live admission or unavailable Computer capacity returns 409.

Retain the request UUID for retries. Reusing the same owner, Team and UUID with
the same goal returns the frozen Thread, without resetting its gate or delivering
another command. A different goal returns 409. Definition edits do not rewrite
an existing run. A linked command is replayed as existing work, without rerouting
its assignee. A cancelled Thread cannot be reopened. Different UUIDs create
separate Threads. Cancellation/deletion requires the owner's login session;
service headers with an owner cookie cannot confer that authority. Cancellation
remains available after live Agent admission becomes invalid.

For an existing ledger, `POST /api/v1/threads/{sessionId}/workflow-decisions` records a gate
answer or recovery action. Its JSON body must contain exactly `kind` (`approve`, `reject`, `retry`, `cancel` or `answer`),
`workflowRunId`, `workflowStepId`, `workflowAttempt` (positive integer),
`assignmentId`, and `expectedRevision` (nonnegative integer); an `answer` also
carries `answer` (1–4,000 characters after trimming). The server supplies
the audit actor, event identity and timestamp. Unknown fields are rejected.
The response includes the updated Thread with its current `execution` phase,
so clients can show an admitted retry or answer immediately.
When a Workflow awaits approval, awaits input, or is blocked, its prepared
request has no live attempt. Thread reads report `execution.phase: "terminal"`
with `workflow_waiting_for_human` or `workflow_blocked` as the blocking reason.
Stop and delete cancels the prepared request before removing the Thread.

A step that stops with a blocked round result carrying a question (`note`,
optionally `options`) records an attempt result with status `question` and parks
the ledger at `awaiting_input` (a linked Task reads `waiting_for_human`) instead
of `blocked`. Only `answer` or `cancel` applies there. An answer allocates the
step's next attempt, sets the ledger to `ready` without asking the step's
approval gate again, and queues it with every earlier question and answer for
that step in its brief. Like retry, it requires exit evidence for the asking
attempt.

Only the owning user's real login session may decide; service actors (including
service headers with an owner cookie), Computer credentials and foreign admins
are refused. The live Project must still belong to that owner and match the
frozen Computer. Approval revalidates the frozen roster's enabled Project
membership, Agents and Placements. Definition edits do not rewrite the waiting
run. Rejection remains possible with a disabled assignee.

Success returns the updated Thread snapshot (200). Invalid bodies return 400;
a missing Thread returns 404; ownership violations return 403; stale, duplicate,
closed or mismatched attempts and invalid live approval admission return 409.
Approval, the gate event and current-step publication share one transaction;
conflicting decisions cannot both consume the same revision. A publication or
live-admission failure rolls back the approval and command. Approval sets the
ledger to `ready` and queues exactly one command for the frozen current attempt;
`agentRuns` and the durable request record the execution. Rejection sets
`blocked` and queues nothing. Imported ledgers without the linked prepared
request are refused; this endpoint does not invent execution linkage for them.
No client should use the legacy decision route for workflow gates.

**Sequential execution and owner recovery are supported by the workflow-specific
adapter (W2b).** Each command requires a daemon advertising both `round-result`
and `workflow-results`. The latter guarantees the daemon forwards the verified
`runId` with the structured report; older clients must update before dispatch.
The agent writes the existing run-bound round-result envelope with outer
`status: "done"`, matching `runId`, and `work: {status: "done", evidence: [...]}`.
Evidence must describe concrete checks against the step’s acceptance criteria.
Recorded `work.outputs` are optional for new steps. Existing frozen runs still
require a nonblank value for every saved `expectedOutputs` name. When supplied,
output maps contain at most 32 entries, keys at most 2,000 characters, values at most
8,000 characters, and at most 65,536 characters combined. The normal work report
validation also applies. These are attributed reports, not backend verification
of artifact correctness or satisfaction of the acceptance criteria.

`workflow.step_finished` records the attempt result and advances the frozen
index only for successful execution and a valid structured success report with
nonempty completion evidence (plus any legacy frozen output requirements).
Missing, rejected, truncated or failed results block the current step. Earlier
successful results, including evidence and any recorded outputs, are included in
every successor's assignment brief. Repeated assignees retain distinct step/attempt
identities. The final successful step completes the Thread. No legacy repair,
consultation, delegation or report-reminder policy applies.

A successor gate remains `awaiting_approval` until the owner approves that exact
attempt/revision. Ungated successors revalidate the live Project, current enabled
roster membership, pinned Logical Agent/Placement, Computer and executor before
publication. Invalid admission records `workflow.admission_blocked` and requires
owner retry. Transient capacity/liveness unavailability leaves the successor
prepared and unreserved for recovery; it does not rerun completed work.

`retry` is accepted only for a blocked attempt with no live command, running
Agent projection or active execution reservation. Terminal projection or an
explicit owner reconciliation must have settled the previous execution first.
It appends `workflow.recovery_decided`, allocates the next deterministic attempt
identity, preserves the frozen definition and successful predecessor outputs,
and requires a fresh approval if the step is gated. Stale/concurrent retries
return 409 and cannot publish two commands. `cancel` records the owner decision
and cancels the workflow without requiring a valid live roster. Delivered
execution reservations remain held until daemon exit or recorded human
reconciliation; late success cannot advance a cancelled workflow.

The existing `/execution/reconcile` route additionally requires the workflow
owner's real session. For an interrupted workflow that has not been cancelled,
it records both `session.execution_reconciled` and `workflow.interrupted`, leaves
the current step blocked, and permits a separate explicit retry. It never
converts human assertion into successful execution evidence.

Terminal projection and cursor updates are atomic. Prepared successor recovery
uses the same ledger-bound admission adapter; published commands are never
recreated on replay. Workflow events are authoritative and materialize on
restart. Project Tasks may assign a workflow Team only in that Team's Project.
`POST /tasks/{id}/runs` and the background scheduler (assigned Tasks and Automation
occurrences, acting for the Task owner — `tasks/scheduled_workflow.py`) enter the
dedicated adapter: Task dispatch claim, frozen
Thread, durable workflow request, `task.execution.claimed` generation and Task/Thread
link commit atomically. Gates and retries retain this generation and request;
stale generations cannot publish successors or change a newer Task owner. A gate
projects `waiting_for_human`, a failed/rejected step `blocked`, and complete workflow
success follows the Task's existing acceptance policy (`review` for human acceptance).
Cancellation retains delivered execution reservations until exit/reconciliation.
When a workflow step asks its owner a question, its linked Task records a
`waitingRequest` of kind `question` with a stable per-attempt `questionId`,
`inputQuestion`, and optional `inputOptions`, plus `waitingSessionId`. Task list
and detail responses expose this through the shared `awaiting` projection.
Answering through `/threads/{id}/workflow-decisions` or cancelling clears the
wait; another question from a later attempt receives a new id.
Task Activity reads all linked Threads' frozen ledgers, including every failed and
retried attempt, outputs, evidence, timestamps and decisions. Generic Agent-run,
conversation, legacy approval and unsupported staged-command recovery remain
fail-closed with `team_workflow_execution_unavailable`. Standalone or another
Project is refused with `team_workflow_project_mismatch`.

The web client (W2c) projects `workflow.started`, `workflow.gate_decided`,
`workflow.interrupted`, `workflow.admission_blocked`, a `cancel` recovery
decision, and a cancelling `session.status` exactly as the session reducer does
(`web/src/lib/workflowRuns.ts`). It does not recompute a step result
(`workflow.step_finished`) or a retry's next attempt identity: those, and any
event whose revision does not match the cached run, mark the thread as owing a
snapshot, and the client refetches `GET /threads/{id}` instead of guessing.
`backend/tests/unit/test_workflow_client_parity.py` pins the shared fixture
`web/tests/fixtures/workflow-events.json` that both sides are tested against;
regenerate it with `RELAY_UPDATE_FIXTURES=1` after an intentional reducer change.
The W3 editor, run start, thread progress and decision slip use only the routes
above. Integrated release verification, including themes/device sizes against a
real backend and daemon, remains W4; this API does not claim release readiness.

### Independent Project Workflows

Custom definitions belong to their creating Team or Project (exactly one owner).
Team-owned definitions are reusable for that Team’s Tasks and Automations across
compatible execution Projects; Project definitions apply within their Project.
The owner-session API is `GET/POST /api/v1/workflows`,
`GET/PATCH/DELETE /api/v1/workflows/{id}`, and
`POST /api/v1/workflows/{id}/runs`. List accepts optional `projectId`; run
accepts `requestId`, `taskGoal`, and optional eligible `teamId`. Team-owned
definitions additionally require their owning Team and an execution `projectId`.
A new run freezes `workflowSnapshot`, retaining `teamSnapshot` as a wire alias.

The Team profile reads `GET /api/v1/teams/{teamId}?view=preview` for Workflow
previews and its members' Agent placements. The Team roster keeps the smaller
member summaries.
The roster editor reads `GET /api/v1/teams/{teamId}/member-choices` for Agent
choices on the Team's Computer and current members who may have moved. Both
responses carry the placement fields needed for Computer labels and routing.

Team assignment uses `PUT/DELETE /api/v1/teams/{teamId}/workflows/{id}/link`.
Unassignment preserves the definition.
The owner can read `GET /api/v1/teams/{teamId}/workflow-choices` for enabled
Project Workflows whose steps fit the Team roster and whose Projects are active
on the Team's Computer. It returns Workflow IDs, names, and Project IDs, along
with IDs and names of Projects used by the choices or linked Workflows.
Already linked eligible Workflows remain in the projection. Project-scoped Team defaults use
`PUT/DELETE /api/v1/teams/{teamId}/workflow-defaults/{projectId}` (PUT body:
`{workflowId}`). They materialize in `projectWorkflowDefaults`.

Task/Automation assignments may include `assignedWorkflowId` without
`assignedTeamId` for a standalone custom Workflow. Predefined selections still
require a Team. Project scope and live participant access remain mandatory.
See [Teams and Workflows](guides/team-workflows.md) for payloads, compatibility,
and migration 0129's forward-only recovery boundary.
