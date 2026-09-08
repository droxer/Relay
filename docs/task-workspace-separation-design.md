# Per-task workspaces for backlog tasks and routines

**Date:** 2026-09-02
**Status:** Approved, ready for implementation planning

**Update:** Implemented; binding persistence and capability fallback are refined by
[ADR-018](adr/018-durable-task-workspace-bindings.md). The original decisions below
are retained as design history.

## Problem

A task dispatches one session per round, each linked through
`task_store.link_session`. Every session defaults to `workspaceLayout: "thread"`,
so the daemon gives it its own directory at `<nodeRoot>/<sessionId>/`
(`ThreadWorkspaceManager.ensure`). Consequences:

- Round 2 of a task starts in an empty directory and cannot see round 1's work.
- A reviewer agent dispatched into a sibling session cannot see what the
  implementer produced.
- `task_rounds.continuation_session_id` exists only to work around this: a
  continuation round is forced back into the original thread because "a thread
  workspace belongs to its session".
- An employee has no way to browse what a task actually produced on disk. The
  artifact index (`GET /api/v1/tasks/{id}/artifacts`) shows indexed document-type
  files only, after the fact.

Projects already solve this shape of problem: a durable `workspaceSubpath` under
the node root, `workspaceLayout: "project"`, browse endpoints, and a UI. Tasks
should get the same treatment.

## Goal

Each backlog task and each routine occurrence runs in its own durable workspace,
shared by every round and every agent working that task, and the owning employee
can browse its contents from the task drawer.

## Decisions taken

1. **Routine scope** — routine root plus per-run subdirectory. Occurrences are
   isolated from each other but browsable together under one routine root.
2. **Project overlap** — the project wins. A task dispatched into a project keeps
   running in the project workspace; only non-project tasks get a task workspace.
3. **UI surface** — a new section in `TaskDrawer`, not a new page and not folded
   into the artifact list. `TaskDrawer` is a stacked column of sections, not a
   tabbed surface, so the new workspace browser joins that stack.

## Non-goals

- Relaxing `task_rounds.continuation_session_id`. A task workspace makes it
  possible for a continuation round to start a fresh thread and still see prior
  work, but that changes round semantics and belongs in its own change. Recorded
  as a follow-on below.
- Changing project workspace behavior in any way.
- Changing chat threads without a task; those stay on the `thread` layout.
- Retrofitting existing tasks. A task already dispatched keeps the layout its
  session recorded.

## Design

### 1. Subpath derivation and data model

No new store and no new persisted field. A task's workspace identity is derived,
the same way a project's `workspaceSubpath` is a pure function of its id.

| Task | Subpath under the node root |
|---|---|
| Backlog task, no project | `tasks/<taskId>` |
| Routine occurrence | `tasks/<sourceRoutineId>/<taskId>` |
| Routine itself (never runs) | `tasks/<routineId>` — browse-only parent |
| Task inside a project | unchanged: the project's `workspaceSubpath` |

Occurrences already carry `sourceRoutineId` (`backend/relay/persistence/task_store.py`,
`routine_occurrence_events`), so the two-level path needs no new field.

One new module, `backend/relay/services/task_workspace.py`, owns this and nothing
else:

- `task_workspace_subpath(task) -> str` — the table above.
- `resolve_task_workspace(task, node, *, project_snapshot) -> tuple[str, str | None]`
  — the `(layout, subpath)` pair a dispatch should use, including the capability
  fallback described in section 3.

This is the single seam for the derivation, mirroring how
`backend/relay/services/computer_limits.py` is the one place a personal-computer
limit resolves. Call sites do not recompute paths.

The session continues to record `workspaceLayout` and `workspaceSubpath` exactly
as it does today; only the values change. Continuation rounds reuse the session,
so a task's layout is fixed at first dispatch.

### 2. Protocol and daemon

- `WorkspaceLayout` in `packages/relay-core/src/session-store.ts` becomes
  `"node-root" | "thread" | "project" | "task"`. It flows through
  `DaemonWorkspaceLayout` in `daemon-node-protocol.ts` unchanged.
- `ThreadWorkspaceManager.resolveProject` / `ensureProject` are already generic
  subpath resolution with symlink rejection and realpath containment. Rename to
  `resolveSubpath` / `ensureSubpath`; `validateProjectSubpath` becomes
  `validateWorkspaceSubpath`. Both `project` and `task` layouts call them.
  Behavior is identical — the rename is what the second caller earns.
- `packages/relay-daemon/src/index.ts`, run branch: the `task` layout resolves
  through `ensureSubpath` alongside `project`.
- Same file, `workspace.list` / `workspace.read` branch: `task` resolves through
  `resolveSubpath` alongside `project`.
- Same file, `workspaceRunGate` key: **the `task` layout must produce a gate key.**
  Two agents in one task now share a directory; without the gate, concurrent
  rounds stomp each other. This is the correctness-critical line of the daemon
  change.
- New capability `task-workspaces` advertised at registration.

### 3. Backend dispatch, gating, and artifacts

- The run-request builders stop hardcoding the layout and ask
  `resolve_task_workspace` instead:
  - `backend/relay/services/task_dispatch.py`, `TaskDispatcher._request`
  - `backend/relay/tasks/scheduler.py`, scheduled dispatch
  - `backend/relay/collaboration/service.py`, the project branch
  Chat threads without a task are untouched and stay on `thread`.
- `backend/relay/daemon_registry/node_backend.py`, `_run_controller`: widen the
  `("thread", "project")` allowlist to include `"task"`.
- **Capability fallback is decided at dispatch, not at command build.** The node
  is already chosen when the request is assembled, so `resolve_task_workspace`
  returns `("thread", None)` when the node does not advertise `task-workspaces`.
  The session then records the truth, and the registry gate never has to
  disagree with a session it did not create. The `project` gate keeps failing
  hard — a project *is* its workspace, while a task on an older daemon degrades
  cleanly to today's per-thread behavior.
- `backend/relay/daemon_registry/registry.py`, run command build: send
  `workspaceSubpath` for `task` as well as `project`.
- Same file, `_record_generated_workspace_artifacts`: add a `task` branch using
  the existing `_confined_workspace_path`, so generated-file artifacts keep
  resolving to real paths under the task workspace.

### 4. Browse routes and authorization

Two routes in `backend/relay/api/task_routes.py`, structurally identical to the
project pair in `project_routes.py`:

```
GET /api/v1/tasks/{task_id}/workspace/files?path=
GET /api/v1/tasks/{task_id}/workspace/file?path=
```

Both go through the shared `workspace_transport` helpers
(`dispatch_workspace_command`, `live_workspace_listing`, `live_workspace_file`,
`raise_workspace_error`, `workspace_path`).

**Authorization** reuses `get_task_for_actor`, the same helper
`GET /tasks/{id}/artifacts` already uses, so owner and admin rules cannot drift
between the two task surfaces.

**Node resolution** differs from projects, which pin a `computerId`. A task's
computer lives on its sessions: take the newest linked session's `daemonNodeId`,
and for a routine fall back to its newest occurrence's session through the
existing `occurrence_tasks` helper. That node must be online and advertise
`workspace-read-shared`, otherwise the route answers
`503 {"reason": "placement-unavailable"}` — identical to projects and to
`node_workspace_routes.py`. An offline computer means no live browse; the
artifact index remains the durable record.

A task that has never dispatched has no session and therefore no node. The
routes answer `503 {"reason": "placement-unavailable"}` for that case too — the
workspace does not exist yet, and the UI renders it as an empty state.

### 5. Web surface

- `web/src/types.ts`: the `workspaceLayout` union gains `"task"`; add
  `TaskWorkspaceFilesResponse` and `TaskWorkspaceFileResponse` (shapes match the
  project responses).
- `web/src/api.ts`: `listTaskWorkspaceFiles` and `readTaskWorkspaceFile`.
- New `web/src/components/task-board/TaskDrawerWorkspace.tsx`, placed in the
  drawer stack between `TaskDrawerArtifacts` and the history/ledger section —
  files produced sit next to files indexed. It reuses `WorkspaceFileList`,
  `WorkspacePathBreadcrumb`, and `WorkspaceFilePreview`, and drills down in one
  column the way `ThreadSpaceFiles` does. No new route, no nav entry.
- Renders for both drawer variants: a routine lists its occurrence directories,
  a task lists its files.
- Placement-unavailable renders as an explanatory empty state, not an error.
- New `backlog.workspace*` keys in `web/src/i18n/locales/{en,zh-CN,zh-TW}/translation.json`.

### 6. Error handling

- Daemon path validation rejects escapes before any read reaches disk; that
  machinery is inherited unchanged from the project layout.
- A node without `task-workspaces` degrades to the `thread` layout at dispatch
  rather than failing the run.
- A node that is offline or lacks `workspace-read-shared` yields
  `503 {"reason": "placement-unavailable"}`, surfaced in the UI as an empty state
  explaining the computer is unavailable.
- Another employee's task yields `403` from `get_task_for_actor`.

### 7. Testing

TDD throughout, red before green.

Backend (`backend/tests/`):
- Subpath derivation, including the routine two-level case and the project
  passthrough.
- Dispatch records `workspaceLayout: "task"` and the derived subpath.
- Fallback to `thread` when the chosen node lacks `task-workspaces`.
- Browse routes: owner reads, another employee gets 403, offline or
  non-`workspace-read-shared` node gets 503, never-dispatched task gets 503.
- Generated-file artifact paths resolve correctly under the `task` layout.

Daemon (`packages/relay-daemon/tests/daemon.test.ts`):
- `task` layout resolves and creates the directory.
- Path escape is rejected.
- `workspaceRunGate` serializes two runs sharing one task workspace.

Web:
- `TaskDrawerWorkspace` loading, empty, populated, and placement-unavailable
  states.

## Follow-on

`task_rounds.continuation_session_id` forces a continuation round back into the
original thread solely because a thread workspace belongs to its session. Once a
task owns its workspace that constraint is gone, and a continuation round could
start a fresh thread while still seeing prior work. Worth doing; out of scope
here because it changes round semantics.
