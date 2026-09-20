# HTTP API and Web URL Contract

Relay's canonical JSON API base is `/api/v1`. The interactive API documents are
available at `/api/docs`, the OpenAPI document at `/api/openapi.json`, and ReDoc
at `/api/redoc`. `GET /api` returns the current version, base path,
documentation locations, and UI metadata from the backend's shared constants.

## Browser URLs

```text
/login
/threads
/threads/new
/threads/{threadId}
/projects
/projects/{projectId}
/projects/{projectId}/new
/projects/{projectId}/threads/{threadId}
/backlog
/routines
/agents
/agents/{agentId}
/teams
/teams/{teamId}
/skills
/channels
/computer
/admin
```

Agent lists use `q` and `availability`. Agent and team details use
`tab`; project details use `tab` plus `path` and `item` on the Workspace tab;
an open thread-space panel writes `space=1` with `artifact`; create dialogs use
`dialog=create`. IDs are percent-encoded path segments. Navigation to another
route or entity removes query state owned by the previous destination.

Unauthenticated deep links are replaced with `/login?returnTo=...`. Relay
accepts a return path only when it is same-origin and matches a recognized web
route. `/` is replaced with `/threads`.

## API Namespaces

| Namespace | Purpose |
| :- | :- |
| `/api/v1/auth` | Bootstrap, login, logout, current user, preferences |
| `/api/v1/threads` | Session-backed threads, events, artifacts, decisions, handoffs |
| `/api/v1/tasks` | Backlog and routine resources, assignment, pickups, runs |
| `/api/v1/agents`, `/api/v1/teams` | Current-user agents and teams |
| `/api/v1/skills` | Employee-owned catalog, immutable revisions, and agent grants |
| `/api/v1/admin/agents`, `/api/v1/admin/agent-placements` | Admin logical-agent and placement CRUD |
| `/api/v1/agent-runs` | Ad-hoc agent-targeted run dispatch |
| `/api/v1/projects` | Computer-bound project rosters and shared-workspace rooms |
| `/api/v1/sandboxes`, `/api/v1/daemon-nodes` | Execution-plane observations and commands |
| `/api/v1/artifacts`, `/api/v1/workspace` | Generated artifacts and workspace reads |
| `/api/v1/admin` | Administrative users, employees, fleet, agents, teams, and integrations |
| `/api/v1/internal/chat` | Chat-service identity and conversation operations |
| `/api/v1/daemon-node-registrations` | Daemon heartbeat registration |
| `/api/v1/daemon-node-enrollments` | Managed and local daemon enrollment |

Persisted media uses `/profile-images/{kind}/{id}` and intentionally stays
outside the JSON version namespace.

`GET /api/v1/tasks` returns complete task records for compatibility. Browser
list views may request `GET /api/v1/tasks?view=summary`, which omits `events`
and `activity` and returns `eventCount`, `activityCount`, and `lastActivity`
instead. An optional `limit` is clamped to 1–500; omitting it does not silently
truncate either projection.

## Normalized Mutations

```text
PATCH  /api/v1/threads/{id}                         { title } or { archived: true }
POST   /api/v1/threads/{id}/cancellations
POST   /api/v1/threads/{id}/messages               { text, intent, addressAgentId?, userMessageId?, idempotencyKey? }
POST   /api/v1/threads/{id}/recoveries             { kind, targetAgentId, mode, note?, idempotencyKey? }
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

Thread collaboration inputs are semantic. `intent` is `accomplish`, `discuss`,
or `review`; omitting `addressAgentId` addresses the current room. Recovery
`kind` is `rerun` or `handoff`. The backend resolves membership, executor,
placement, and immutable round assignments; clients do not send those transport
details.

Use `/threads/{id}/recoveries` with `kind: "handoff"` to dispatch a receiving
logical agent. The legacy `/threads/{id}/handoffs` and handoff decisions under
`/threads/{id}/decisions` record session metadata only; they do not dispatch an
agent. A successful metadata response is not evidence that a receiver started.

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
and prior-context excerpts, and run/artifact/progress-file references. Retrying
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
`<progressFile>.handoff.json` with their assignment ID, completed/pending work,
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

`GET /api/v1/projects` returns the current employee's active and archived
projects so historical project threads keep their original grouping. Creating a
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
    "functionTitle": "Technical lead",
    "responsibilities": "Plan and accept delivery",
    "instructions": "Optional project-only instructions"
  }]
}

GET    /api/v1/projects/{id}
PATCH  /api/v1/projects/{id}     { expectedVersion, name?, leadAgentId?, members?, enabled? }
DELETE /api/v1/projects/{id}?expectedVersion={version}
GET    /api/v1/projects/{id}/workspace/files?path={relativePath}
GET    /api/v1/projects/{id}/workspace/file?path={relativePath}
```

The selected Computer must advertise `project-workspaces`; every enabled member
must be an enabled agent with an active placement on that Computer. A project
may start with an empty roster and `leadAgentId: null`; adding members requires
an enabled lead from that roster. Removing the last member clears the lead.
A project has at most 32 members. Names and function titles are limited to 120
characters, responsibilities to 4,000 characters, and optional project
instructions to 8,000 characters. Updates use optimistic versions; stale writes
return `project_version_conflict`. Duplicate live names return
`project_name_taken`. Archiving is a soft delete: it disables future dispatch
while preserving tasks, threads, events, and workspace files.
Employees with active projects cannot be soft-deleted. After all their projects
are archived, employee soft deletion is allowed and retains the project history.

Project workspace reads address the persistent shared project root directly;
they do not require a Thread. They are live-only and return
`placement-unavailable` when the bound Computer is offline or lacks
`workspace-read-shared`. `GET /api/v1/workspace/brief?projectId={id}` returns
that project's recent Threads, active tasks, active runs, artifacts, and bound
Computer. `projectId`, `agentId`, and `teamId` brief selectors are mutually
exclusive.

Task/thread creation accepts `projectId`. Project dispatch rejects Computer,
team, or non-member overrides; the backend resolves the fixed roster and the
current daemon instance for the project's stable Computer identity.

## Daemon node workspace reads

Generated artifact downloads under
`GET /api/v1/threads/{threadId}/artifacts/{artifactId}` serve the stored daemon
snapshot as an attachment with a restrictive content security policy. The backend
never reads a daemon workspace path from its own filesystem. An artifact without
a content snapshot returns 404; live workspace browsing remains available through
the owning daemon. Older daemons must report generated files and their content to
make new downloadable snapshots available.

Daemon nodes expose the same workspace-read shape used by projects:

```text
GET /api/v1/admin/daemon-nodes/{nodeId}/workspace/files?path={relativePath}
GET /api/v1/admin/daemon-nodes/{nodeId}/workspace/file?path={relativePath}
```

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

`GET /api/v1/daemon-nodes/{id}/commands` returns `commands` plus a `heartbeat`
observation containing `observedAt` and matching `commandLeases`, and
`processingMs` measuring server-side poll processing (including long-poll
waiting). Daemons subtract transport time from each observed remaining lease,
excluding `processingMs` from that transport estimate. An empty successful poll
without matching lease evidence does not confirm execution ownership.
Delivered `run.start` commands are never redelivered solely because their lease
expired. Their original terminal evidence remains valid until settled; cancels
and workspace reads continue to use retryable delivery leases.

Managed-node retry creates an attempt with `replaceActive: true`; draining
patches `desiredState` to `stopped`. `tasks/claim-next` is retired and has no v1
operation.

Resource creation returns `201`. Runs, cancellations, and provisioning that are
queued return `202`. A synchronous deletion returns `200` when it returns a
representation and `204` otherwise.

## Shared skills

Catalog routes require an authenticated employee. Private skills are visible
only to their owner; organization skills can be browsed and granted by other
employees. Only the publisher can edit or delete a skill. Each employee can
grant only to their own logical agents.

| Method and path under `/api/v1` | Request / result |
| :- | :- |
| `GET /skills` | `{skills}` with the caller's granted-agent counts |
| `POST /skills` | Metadata plus `files: [{path, contentBase64}]`; returns the created skill |
| `GET /skills/{id}` | Skill, revision history, current file manifest, caller-owned granted agent IDs |
| `PATCH /skills/{id}` | `displayName`, `description`, or `visibility` |
| `DELETE /skills/{id}` | Soft deletion; returns 204 |
| `POST /skills/{id}/revisions` | `files` and optional `note`; creates an immutable revision |
| `POST /skills/import` | Metadata, GitHub `url`, optional `ref` (HEAD), `subpath` |
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

New task runs require a daemon advertising `task-workspaces`. The run admission
records `task.workspace_bound`; conflicting bindings are rejected. Commands with
`reportWorkspaceStatus: true` accept a lease-validated `run.workspace` event with
`waiting: boolean` and optional `blockingSessionId`. These transitions materialize
as `task.workspace_wait` events; an acquire clears the matching run's wait state.

### Task flow and acceptance

Task consumers should use `workflowStage` for the five board stages (Backlog,
Ready, In progress, Review, Done) while retaining `status` for execution and waiting
conditions. An execution claim reserves WIP but remains Ready; the task enters In
progress only when the daemon reports that an agent has started. `GET /tasks` and
`GET /tasks?view=summary` also return
`flowPolicy: { wipLimit, scope: "employee" }`.

New tasks accept only Backlog/Ready as initial status. `acceptancePolicy` is
`human` (default) or `automatic`; it is immutable once work starts. Successful
human-policy work enters Review, and `PATCH /tasks/{id}` with `status=done`
accepts it. Manual transitions to running or human waiting return 409; use the
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
`code=task_wip_limit` with `state=queued`; this is a capacity wait and does not
consume a failure retry. See [the task lifecycle](task-kanban-lifecycle.md) for
transition, capacity, history compatibility, and migration policies.

### Thread execution and deferred deletion

`GET /api/v1/threads/{id}/execution` returns the same `execution` object included
in thread detail and list responses. It reports `phase`, `executionConfirmed`,
`canDelete`, `blockingReason`, `deletionRequested`, `lastConfirmedAt`, and
`nextRecoveryAt`, plus `canRetrySave` and `canReportGone`. These capabilities
reflect current execution state; operation routes still check actor authorization
and revalidate state. `canReportGone` is false outside `recovery_required` and
when a terminal result is retained for finalization; saved evidence must be
recovered rather than discarded. Clients talking to an older backend must at
least gate recovery actions on `recovery_required`. Phases are `queued`, `running`, `stopping`, `unresponsive`,
`finalizing`, `terminal`, and `recovery_required`. A live command lease confirms
execution ownership; task/session outcome alone never proves remote termination.

`DELETE /api/v1/threads/{id}?stop=true` records an event-backed deletion request
and stops outstanding work. It returns `204` when deleted or `202` with the
execution object while cleanup is pending. Repeating a pending request does not
create another deletion event. Pending deletion prevents new admission and
remains visible in thread responses as `deletionRequestedAt`. The backend resumes
cleanup after restart, without requiring browser polling. It clears conversation
bindings and unlinks tasks before deleting thread history. Workspace files are
not removed by this operation.

The existing unqualified DELETE remains synchronous and returns `409` while the
shared lifecycle says deletion is unsafe. All deletion and explicit recovery
endpoints require a human actor with access to the thread; daemon tokens cannot
use them.

`POST /api/v1/threads/{id}/execution/recovery` requests another bounded round of
finalization retries after a `finalization_failed` blocker. It does not clear a
live execution reservation or treat an unreachable computer as stopped. Missing
terminal evidence and unconfirmed execution require restoration of the execution
host/evidence; retrying finalization cannot manufacture proof of exit.

Stop requests that remain unconfirmed for 60 seconds while the daemon still holds
its lease surface `recovery_required` / `termination_unconfirmed`. They retain
execution ownership. A disconnected daemon instead surfaces `unresponsive`.
The watchdog cannot confirm exit after the daemon itself crashes; neither the
recovery endpoint nor deletion treats that silence as termination.

## Team responsibilities and work acceptance

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
`on_request` (only when addressed). Verification and review are required by
default; other specialists are optional for plan selection. The lead always
coordinates and owns final synthesis. An on-request membership cannot also be
required. Once a proposed plan selects work, that work is required to finish.

Responsibilities are limited to 4000 characters. Criteria and output lists allow
at most 20 nonempty strings of at most 2000 characters. Updates replace the
supplied configuration map; omitted maps remain unchanged. Removing a member
prunes its configuration. The API rejects capability/tool-policy fields in these
configs; roles and work scopes never grant permissions.

Configured teams require a daemon advertising `work-results`. Its run-bound
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

A coordinator can include `work.plan`, a list of up to 16 items containing only
`agentId`, `objective`, `acceptanceCriteria`, and `expectedOutputs`. The backend
validates the plan against admitted participants and required contributions and
persists an immutable child round before delivery. Clients still submit semantic
messages, not daemon assignments. Two repair cycles and two earlier-teammate
consultations are permitted per request. See
[ADR-019](adr/019-team-work-acceptance.md) for ordering, replay, and compatibility.

## Personal-computer installation

`POST /api/v1/daemon-node-enrollments/local` additionally returns `installCommand`,
a shell-quoted `curl … | sh -s -- …` command scoped to the enrolled computer. It
contains no token; the installer reads the existing node token from `/dev/tty`.
`daemonCommand` and `daemonEnv` remain available for compatibility.

Public non-JSON download routes at the backend origin:

- `GET /computer/install.sh`: POSIX shell installer pinned to the current client
  archive checksum, `Cache-Control: no-store`; 503 if the client was not built.
- `GET /computer/daemon-{sha256}.tar.gz`: compiled client archive, immutable
  caching; 404 if the requested digest is not the deployed release.

These routes serve build artifacts only. All enrollment and execution still
flow through authenticated registry routes and the user's daemon.

For existing personal computers, `GET /api/v1/daemon-nodes/{id}/token` and
`POST /api/v1/daemon-nodes/{id}/token/reissue` also return `installCommand`.
The Token drawer prefers it for installation/reconnection. BoxLite computers
and records lacking the owner/workspace needed by the installer retain
`daemonCommand`; neither response embeds the token in a command.
