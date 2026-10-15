# Agent-First Runtime Design

## Status

Accepted for incremental implementation. The first vertical slice is
implemented: event-sourced user agents and placements, compatibility
translation for legacy requests, agent-targeted dispatch,
per-assignment Computer placement, run audit identity, logical-agent instructions,
user chat selection, and an admin Agents view.

PostgreSQL-backed agent/placement stores, durable task and routine assignment
by logical Agent, stable Computer identity, and Computer-affine team dispatch
are also implemented. Artifact transfer, placement reconciliation, broader
named-agent clients, and compatibility retirement remain rollout work.

## Summary

Users should work with named agents. They should not need to understand
which replaceable Daemon Node currently serves a Computer. Computers advertise
Agent Runtime capabilities through their Daemon Nodes; the control plane binds
user-owned Agents to a required runtime on a stable Computer and resolves a
healthy current node for every run.

The current relationship:

```text
computer -> daemon node -> supported executor names
```

becomes:

```text
user -> logical agent -> placement -> agent runtime -> computer -> daemon node
```

This permits one user to own several agents, including multiple agents of
the same Agent Runtime kind. Independent Agents may live on different
Computers, while Agents assembled into one Thread must use runtimes on that
Thread's Computer.

## Goals

- Make the logical agent the user-facing unit of identity and selection.
- Allow a user to own multiple agents distributed across nodes.
- Separate agent configuration and policy from runtime health and capacity.
- Route each workflow assignment to a compatible healthy placement.
- Preserve daemon-only execution, command leases, event-sourced sessions, and
  managed-node reconciliation.
- Support gradual migration without breaking existing sessions or daemons.
- Keep node details available to administrators for infrastructure operations.

## Non-goals

- Scheduling one agent run across several nodes simultaneously.
- Transparent workspace replication in the first release.
- Autoscaling provider infrastructure from queue depth in the first release.
- Allowing arbitrary executor kinds beyond `claude`, `pi`, `codex`, and `kimi`
  during this migration.
- Removing manual daemon-node registration.

## Terminology

| Term | Meaning |
| :- | :- |
| Executor kind | Runtime implementation: `claude`, `pi`, `codex`, or `kimi`. This replaces the ambiguous use of agent name for a CLI type. |
| Logical agent | User-owned identity with a name, executor kind, role, instructions, and policy. |
| Runtime capability | A daemon's report that it can execute an executor kind, including health and capacity. |
| Placement | Binding that allows one logical agent to execute through one Agent Runtime on one stable Computer. |
| Placement candidate | A placement that satisfies ownership, health, policy, workspace, and capacity requirements for a run. |
| Runtime node | The observed daemon node that heartbeats and executes leased commands. |
| Managed node | Desired infrastructure resource reconciled by the supervisor. |

## Design principles

### Agent identity belongs to the control plane

A logical agent exists even when all of its placements are offline. Its name,
role, instructions, permissions, and ownership must not be derived from daemon
registration.

### Nodes advertise capabilities; they do not define users

Daemon registration reports what the runtime can execute. User ownership
is attached to logical agents. Registration never creates a logical agent. A
node may host placements for several agents and, subject to policy, several
users.

### Runs target agents and record placements

New run requests target a logical agent ID. Relay selects a placement and
records both the stable logical agent ID and the actual node/placement used.
This preserves the user-facing identity and the operational audit trail.

### Placement is replaceable

Moving an Agent to another Computer must not change its identity or split its
conversation history. Replacing a Computer's Daemon Node does not move the
Agent or recreate its Placement. An unavailable Computer makes a placement
offline, not the logical agent nonexistent.

### Workspace belongs to the thread

Every thread owns one workspace on its selected Computer. All participating
agents execute inside that thread workspace; logical agents have no independent
workspace to move or reuse across threads.

## Domain model

### UserAgent

`UserAgent` is the durable user-owned logical identity.

| Field | Type | Notes |
| :- | :- | :- |
| `id` | string | Stable `agent_...` identity. |
| `userId` | string | Owning user. |
| `displayName` | string | User-facing name such as `Researcher`. |
| `executorKind` | enum | `claude`, `pi`, `codex`, or `kimi`. |
| `defaultRole` | enum | Existing Relay role vocabulary. |
| `instructions` | string, nullable | Agent-specific control-plane instructions. |
| `skillPolicy` | JSON | Reserved for a future enforced skill policy. Non-empty values are rejected and legacy values block dispatch. |
| `toolPolicy` | JSON | Reserved for a future enforced tool policy. Non-empty values are rejected and legacy values block dispatch. |
| `modelPolicy` | JSON | Reserved for a future enforced model policy. Non-empty values are rejected and legacy values block dispatch. |
| `enabled` | boolean | Disabled agents cannot receive new work. |
| `version` | integer | Incremented for placement-relevant configuration changes. |
| `createdAt` / `updatedAt` | timestamp | Audit timestamps. |

Agent display names need only be unique within a user. Executor kind is
not unique: a user may own both `Researcher` and `Reviewer` using Claude.

### AgentPlacement

`AgentPlacement` binds a logical Agent and its required Agent Runtime to a
stable Computer. The current Daemon Node is resolved from `computerId`; its ID
is runtime/audit metadata, never the durable placement boundary.

| Field | Type | Notes |
| :- | :- | :- |
| `id` | string | Stable `placement_...` identity. |
| `agentId` | string | Logical agent. |
| `computerId` | string | Stable Computer identity and durable placement target. |
| `daemonNodeId` | string | Runtime node observed when the placement was created; audit/legacy fallback only. |
| `executorKind` | enum | Must equal the logical agent executor kind. |
| `desiredState` | enum | `active`, `draining`, or `removed`. |
| `status` | enum | `pending`, `ready`, `busy`, `offline`, `incompatible`, or `failed`. |
| `priority` | integer | Lower values are preferred after hard constraints. |
| `agentVersion` | integer | Configuration version realized by this placement. |
| `workspacePolicy` | JSON | Workspace scopes accessible from this placement. |
| `conditions` | JSON array | Structured incompatibility or failure reasons. |
| `createdAt` / `updatedAt` | timestamp | Audit timestamps. |

The initial implementation supports one placement for a logical agent. The
schema permits several historical placement records, but moving an agent
atomically removes its previous active placement. Multi-placement failover and
horizontal capacity remain future work.

### Daemon runtime capability

Daemon registration continues to report Agent Runtime health. These are
Computer capabilities, not Agent identities:

```ts
interface DaemonExecutorCapability {
  executorKind: "claude" | "pi" | "codex" | "kimi";
  status: "ready" | "failed";
  adapter: "cli" | "service";
  maxConcurrentRuns: number;
  inventory?: DaemonAgentInventory;
  configurationFingerprint?: string;
}
```

During compatibility, `supportedAgents` and the existing `agents` health map
remain accepted and are normalized into capabilities by the backend.

### Session and run additions

New assignments carry logical identity and retain executor kind for compatibility:

```ts
interface AgentAssignment {
  agentId?: string;
  agent: "claude" | "pi" | "codex" | "kimi";
  role?: AgentRole;
}
```

Run records add:

- `logicalAgentId`
- `placementId`
- `daemonNodeId`
- `executorKind`
- `agentVersion`

Old assignments without `agentId` are resolved through a compatibility agent
owned by the session user.

## Ownership and authorization

- A user may use agents they own or agents explicitly shared with them.
- A non-admin cannot select an arbitrary daemon node or placement.
- Placement selection occurs only after agent authorization succeeds.
- Non-empty agent policy fields are rejected until the daemon can enforce them,
  and pre-existing non-empty policy metadata makes an agent undispatchable; the
  API must never present stored policy metadata as an effective control.
- Administrators manage placements and runtime nodes; users manage only
  agent settings permitted by policy.
- Audit events record the user, logical agent, placement, daemon node,
  executor kind, and effective policy version.

## Placement and dispatch

For each assignment, the control plane:

1. Resolves `agentId`, verifies ownership/sharing, and checks that it is enabled.
2. Loads active placements matching the agent version and executor kind.
3. Resolves each placement's Computer to its current Daemon Node and rejects it
   when heartbeat, Agent Runtime capability, protocol,
   or policy is incompatible.
4. Rejects placements without access to the session workspace.
5. Rejects placements without run capacity.
6. Prefers existing session affinity, then placement priority, available
   capacity, recent health, and stable placement ID.
7. Acquires or verifies the daemon command lease and dispatches the run.
8. Records the selected placement in the run event before execution begins.

Selection must return structured rejection reasons so the UI can distinguish
`agent offline`, `workspace unavailable`, `capacity exhausted`, and
`configuration pending`.

### Multi-agent workflows

The first assignment selects a Computer and resolves its current Daemon Node.
Every later assignment in the same multi-agent workflow must have an eligible
Agent Runtime placement on that Computer and execute in the same Thread
workspace:

```text
Researcher -> Claude Runtime @ Computer A
    -> Builder -> Codex Runtime @ Computer A
    -> Reviewer -> Claude Runtime @ Computer A
```

The session remains the durable workflow authority. Handoff data is carried by
session events and artifacts, while the Thread workspace provides the
collaboration boundary.

## Workspace policy

The first release defines three explicit workspace compatibility modes:

| Mode | Behavior |
| :- | :- |
| `node-affine` | Legacy name: the Thread remains on placements attached to its original Computer. |
| `shared-path` | Legacy infrastructure metadata for a canonical workspace identity; it does not authorize cross-node collaboration. |
| `artifact-handoff` | Reserved for a future explicit cross-node protocol; it is not a team scheduling mode. |

All current multi-agent workflows are Computer-affine because their workspace
belongs to one Thread on one Computer. See
[ADR-011](adr/011-node-scoped-agent-collaboration.md).

## Managed-node relationship

Managed nodes remain infrastructure desired state. User ownership is
removed from their core identity over time:

- `ManagedNode.userId` becomes an optional placement-policy hint.
- the one-dedicated-node-per-user constraint is removed;
- managed nodes declare capacity, locality, and workspace policy;
- agent placements decide which user agents use that capacity;
- pooled nodes become useful once placements can target them.

The supervisor continues to reconcile infrastructure only. It must not create
logical agents or decide user authorization.

## API direction

### User agents

- `GET /api/v1/agents` — agents visible to the authenticated user.
- `POST /api/v1/admin/agents` — create a logical agent; pass
  `supervisorUserId` in the request body.
- `GET /api/v1/admin/agents/{agentId}` — admin detail including placements.
- `PATCH /api/v1/admin/agents/{agentId}` — update configuration or desired state.
- `DELETE /api/v1/admin/agents/{agentId}` — disable and retire after active runs drain.

### Placements

- `POST /api/v1/admin/agents/{agentId}/placements`
- `PATCH /api/v1/admin/agent-placements/{placementId}`
- `DELETE /api/v1/admin/agent-placements/{placementId}`
- `GET /api/v1/admin/agent-placements?agentId=&nodeId=`

### Runtime nodes

Existing daemon-node APIs remain operational. User-facing responses stop
using daemon node as the primary selectable resource.

### Runs

New clients send `agentId`. During migration, the backend also accepts the
legacy `agent` executor kind and resolves a compatibility logical agent.

## User experience

### User

The primary selector lists named agents with role and availability:

```text
Researcher       Ready
Builder          Busy
Reviewer         Offline
```

Node identity is hidden by default. Diagnostics may show `Runs on node-a` and
placement failure detail when useful.

### Administrator

The control panel separates:

- **People** — users and their logical agents;
- **Agents** — identity, policy, configuration, availability, and placements;
- **Runtime Nodes** — infrastructure, capabilities, capacity, and health.

Agent availability is derived from placements. Runtime-node health is not
presented as user ownership.

## Compatibility and migration rules

- Existing `AgentName` remains the executor-kind type until a later rename.
- Existing sessions and tasks without `agentId` remain executable.
- Daemon registration and Computer assignment never create agents.
- An old request without `agentId` may lazily create a hidden compatibility
  identity for `(userId, computerId, executorKind)`. It exists only to
  translate that request through the logical-agent pipeline and is not returned
  in the user Agent roster.
- Existing node-level disabled-agent and role-default settings remain enforced
  until equivalent placement/agent policy is materialized.
- Daemons can upgrade independently because the backend accepts both old
  health maps and new capability records during the compatibility window.
- No event history is rewritten. New identity links are appended or stored in
  derived compatibility mappings.

## Success criteria

- One user can own multiple logical agents, including two of the same
  executor kind.
- Those Agents can be placed on different Computers.
- Users select agents without selecting nodes.
- Every run records logical agent, placement, runtime node, and executor kind.
- Replacing a Computer's Daemon Node preserves its placements. A Computer
  outage makes only its placements unavailable and does not remove logical
  Agents or history.
- Legacy sessions, clients, and daemons continue to operate during rollout.
- Cross-node dispatch never occurs without a compatible workspace policy.
