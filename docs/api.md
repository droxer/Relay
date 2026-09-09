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

Managed-node retry creates an attempt with `replaceActive: true`; draining
patches `desiredState` to `stopped`. `tasks/claim-next` is retired and has no v1
operation.

Resource creation returns `201`. Runs, cancellations, and provisioning that are
queued return `202`. A synchronous deletion returns `200` when it returns a
representation and `204` otherwise.

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
