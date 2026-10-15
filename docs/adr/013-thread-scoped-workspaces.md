# ADR-013: Isolate Workspaces by Thread on Local and Cloud Computers

## Status

Accepted. This decision refines ADR-011: collaboration remains pinned to one
daemon node, but the writable workspace is shared only by participants in the
same thread, not by every thread assigned to that node.

## Context

A daemon node previously exposed one writable directory to every run. That
made handoffs within a thread simple, but independent threads could overwrite
the same files, contend for one Git checkout, and observe unrelated work. It
also made concurrent read-only runs depend on process-global workspace state.

Relay supports two ownership models for computers:

- on a user-owned computer, the user chooses the workspace root while
  setting up the local daemon;
- on a cloud computer, the backend supervisor's provider adapter chooses and
  provisions the workspace root.

Agents should see the same execution contract in both models.

## Decision

The configured path is a **node workspace root**, not a thread's working
directory. The daemon creates and reuses exactly one child directory for each
thread:

```text
<configured-node-workspace-root>/<thread-id>/
```

The internal `sessionId` is the canonical thread ID and directory name. The
daemon accepts only a bounded portable identifier containing letters, digits,
dot, underscore, and hyphen; it rejects traversal, path separators, and a
symbolic-link thread directory.

The daemon owns this mapping through one interface that returns:

- `hostPath`, used for filesystem snapshots and artifact collection;
- `executionPath`, used as the agent process working directory.

For local execution (`sandbox: none`), both paths are the host thread
directory. For BoxLite execution, the daemon mounts only the selected host
thread directory at `/workspace`; the guest never receives the node root or
sibling thread directories. Every run passes its workspace explicitly; it does
not mutate a process-global environment variable. Because a BoxLite instance
has one mount, the daemon serializes BoxLite runs and restarts the guest when
the selected thread changes.

Agents participating in one thread share its root. A logical agent's private
directory remains `agents/agent-<encoded-agent-id>/`, now beneath the thread
root. That subdirectory is thread-local runtime state, not an Agent-owned
workspace, and it never crosses thread boundaries. Generated-file paths remain
thread-relative in session artifacts. A
daemon advertises the `thread-workspaces` capability so the backend can resolve
host paths correctly during rolling upgrades.

Each `session.created` event records its workspace layout. New sessions use
`thread`; historical sessions without the field are treated as `node-root`.
This compatibility rule keeps an upgraded session on its existing checkout
instead of silently moving it into an empty child directory. Because the old
root could contain work from several sessions, Relay does not guess how to
split or copy it. A future explicit migration may checkpoint a legacy session
into a thread child after an operator verifies its contents.

During a backend-first rolling deployment, a new session marked `thread` may
reach an older daemon. Relay rejects that dispatch until a daemon advertising
`thread-workspaces` is available; it never weakens a new session to the shared
node root. Only genuinely historical sessions whose creation event has no
workspace layout retain `node-root` compatibility.

## Ownership and lifecycle

- User devices: the selected root remains local configuration and must
  already exist and be writable at daemon setup. Relay creates only validated
  thread children beneath it.
- Cloud computers: the supervisor/provider provisions the root and its
  persistent volume or recovery mechanism before starting the daemon.
- Daemon restart: an existing thread child is reused.
- Daemon upgrade: sessions already created under the legacy shared-root model
  continue at that root; only newly-created sessions select thread children.
- Thread archive or deletion: directory retention and garbage collection are a
  separate policy decision; this change does not delete user or cloud data.
- Node reassignment: ADR-011's immutable thread runtime still applies. Moving a
  thread requires an explicit checkpoint/restore design rather than path reuse.

## Consequences

- Independent threads cannot collide through their default working directory.
- All agents and handoffs in one thread retain filesystem continuity.
- Local and cloud computers use the same daemon interface despite different
  root ownership.
- The node workspace browser sees thread directories at its root.
- Every live or snapshot workspace read includes a thread ID. Durable artifacts
  may provide an offline view of that Thread, but are never merged into a
  cross-thread Agent workspace.
- Existing daemons without `thread-workspaces` may continue genuinely
  historical sessions at the legacy node root. The backend rejects new
  thread-layout runs and never sends those daemons a thread-scoped live-read
  command. Upgraded daemons honor each session's recorded layout, and the
  backend interprets generated-file paths using the same layout.
- A BoxLite guest can see only the active thread mount. Local `sandbox: none`
  remains a deliberate host-trust mode and requires an explicit execution
  opt-in.
