# Agent-Facing Product Design

## Decision

Relay is an agent-facing product. A user uses named agents to do work;
users do not operate executors, sandboxes, placements, or nodes.

This document owns the product projection of the model. The durable identity,
placement, and dispatch mechanics are defined in
[Agent-First Runtime Design](agent-first-runtime-design.md) and are not repeated
here.

```text
user (identity and ownership)
  -> agent (product identity and policy)
    -> placement (scheduler decision)
      -> agent runtime (Claude/Codex/Pi/Kimi capability)
        -> computer (stable execution host)
          -> daemon node (replaceable runtime process)
```

The arrow is a dependency boundary, not a navigation hierarchy. Only the first
two concepts belong in the everyday product. Placements and nodes belong to
infrastructure administration and operational audit records.

## Product model

### User

A user is the authenticated principal, owner, and authorization boundary.
It answers “who may see or change this?” It is not a runtime target and should
not be a selector in the user experience.

### Agent

An agent is the primary user-facing object: a durable user-owned
identity with a name, executor kind, instructions, and policy. Its ID remains
stable when an administrator moves it to another Computer, and replacing that
Computer's Daemon Node does not move it at all. Administrators may
create and configure agents. Runtime capability registration never creates an
agent. A hidden compatibility identity may be materialized only when translating
an old executor-kind request during migration.

### Placement

A placement is an internal scheduling relationship between an Agent and its
required Agent Runtime on a stable Computer. The control plane resolves that
Computer's current Daemon Node for every run. It is visible only to
administrators diagnosing capacity or availability.

### Computer and Daemon Node

A Computer is the stable execution host. Its Daemon Node is replaceable
infrastructure that heartbeats, advertises Agent Runtime capabilities, leases
commands, and owns a sandbox. Neither defines a user or an Agent.

## Information architecture

User navigation:

1. **Threads** — conversations with an agent; every new thread starts with an
   explicit agent.
2. **Thread workspace** — artifacts and files shared by agents in one thread.
3. **Backlog** — work assigned to agents. User ownership is derived from
   the selected agent.
4. **Routines** — recurring work assigned to agents.

Administrator navigation:

1. **Users** — identity, access, departments, and owned agents.
2. **Agents** — identity, configuration, availability, and placement management.
3. **Infrastructure** — nodes, capabilities, capacity, heartbeats, and leases.
4. **Channels** — external identity mapping and the default named agent.

No user-facing empty state may offer to provision a node or sandbox. It
must say that no agent is configured or no placement is currently available.

## Interaction contracts

- A new run requires `agentId`. Executor kind is agent configuration, not a run
  identity.
- A conversation records `agentId`; node and placement IDs are audit metadata.
- Continuing, retrying, rerunning, and handing off always resolve a logical
  agent. They never fall back to direct sandbox execution.
- Selecting an assignee selects an agent. `assigneeUserId` is derived from
  the agent owner and cannot conflict with it.
- A routine requires an assigned agent before it can dispatch.
- A channel identity may resolve a default agent, and users may address another
  permitted named agent. Sandbox IDs are not part of channel commands.
- Agent availability is the aggregate of eligible placements. Node health is
  not rendered as the agent's identity.

## API boundaries

Canonical user APIs use `/api/v1/agents`, `/api/v1/agent-runs`,
`/api/v1/threads`, Agent-scoped work resources, and strictly Thread-scoped
workspace resources. Direct
`/api/v1/sandboxes/{id}/runs` endpoints are compatibility-only: they are not called by
the web product, are excluded from new clients, and should be removed after the
daemon migration.

The backend remains the control plane and never executes an agent. Dispatch is:

```text
agent run request
  -> authorize user ownership
  -> resolve agent policy and workspace
  -> select healthy placement
  -> queue daemon command
  -> record agent + placement + node in session events
```

## State ownership

- Authentication state owns the current user. There is no
  `selectedUser` in the user product.
- Shell state owns `activeAgentId` and `activeSessionId`.
- Server state owns agents, sessions, tasks, routines, placements, and nodes.
- Browser storage must not hold per-node tokens for the normal user flow.
- Relay stores agent identity and instructions; the selected placement supplies
  the executor runtime. Agent creation and placement remain administrative
  workflows, not user-facing infrastructure controls.

## Migration rules

1. New writes require logical agent identity.
2. Legacy executor/sandbox fields may be read for old records but are not shown
   as primary UI or accepted by new user workflows.
3. Runtime registration never materializes agents. A legacy request may use a
   hidden compatibility identity internally, but it never enters the user
   agent roster.
4. Chat clients migrate from executor/sandbox options to named agent options
   before direct sandbox run endpoints are retired.
5. Tests assert the boundary: deleting a user disables its agents;
   cross-user dispatch is forbidden; placement changes preserve agent
   history; no user page requires a node ID.

## Completion criteria

The redesign is complete when a user can use every page without seeing or
supplying a node, sandbox, placement, executor kind, or infrastructure token;
and an administrator can move an agent between nodes without changing its
threads, tasks, routines, artifacts, channel identity, or workspace link.
