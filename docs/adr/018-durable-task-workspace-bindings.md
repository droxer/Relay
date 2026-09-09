# ADR-018: Durable task workspace bindings

Status: Accepted

## Decision

A task records `task.workspace_bound` at its first run admission. Its immutable
`workspaceBinding` contains the stable Computer identity, recorded layout and
relative subpath, and the configured workspace root when available. New project
tasks inherit the project workspace; other tasks use `tasks/<taskId>` (routine
occurrences use `tasks/<routineId>/<occurrenceId>`). Standalone threads retain
their existing thread directory.

Future task dispatches and workspace browsing use that binding. Agent placement
changes cannot select another Computer, and changing the configured root requires
restoring the original root or a future explicit migration. A replacement daemon
on the same Computer can use the binding. A session link, unlink, or deletion
does not move or delete a bound task's files. Concurrent binding events with
conflicting identities are rejected before persistence.

Legacy tasks without a binding recover their recorded layout from the newest
surviving linked session. Legacy thread/node-root tasks resume that recorded
thread rather than opening an empty directory. Missing history fails closed;
Relay does not infer legacy workspace contents from current project membership.
New tasks require `task-workspaces`; unsupported daemons no longer silently
fall back to thread workspaces. Existing recorded layouts remain authoritative.

The backend remains the control plane. Only the daemon accesses the execution
workspace. Shared physical directories retain their existing serialization gate.
When a backend sets `reportWorkspaceStatus` on a command, the daemon reports
`run.workspace` wait/acquire transitions. Authenticated, lease-validated events
record `task.workspace_wait`; the browser shows a waiting message and an
accessible blocking conversation. A small status endpoint polls execution state
without dispatching filesystem reads. Terminal runs are never shown as waiting.

Task Files distinguish not-created, empty, offline, unsupported, denied, and
unexpected failure states, and mark shared project files explicitly. Artifact
lists default to the latest version and accept `versions=all`. Downloads prefer
the retained producing-run snapshot over a newer live file at the same path.

## Compatibility and limits

- No database migration is needed: task events are authoritative and the existing
  JSON snapshot stores the projection. Shared TypeScript contracts replay the
  new events.
- Backends must be upgraded before daemons rely on the new task behavior. New
  daemons emit wait events only when the backend opts in on a command.
- Existing artifact snapshot size limits still apply. Legacy/unsnapshotted
  artifacts retain live-file fallback; earlier bytes cannot be reconstructed.
- Routine occurrences keep their own bindings. The existing routine parent
  browser uses the most recent occurrence's Computer; an aggregate browser for
  occurrences distributed across Computers is not introduced here.
- Project-task isolation, worktree creation, snapshot initialization, integration,
  workspace migration, and file garbage collection remain separate changes.
