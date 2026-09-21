# Relay Orchestration

Relay coordinates employee-owned agents while keeping execution on registered
computers outside the control plane.

## Language

**Computer**:
The product-facing execution host on which agents are placed and collaborate.
_Avoid_: Machine, worker

**Daemon Node**:
The execution-plane runtime registered for one computer.
_Avoid_: Sandbox, agent

**Logical Agent**:
The durable employee-owned identity built on an Agent Runtime through a
Placement. Its configuration is independent of the computer that executes it,
and it does not own a workspace.
_Avoid_: Executor, CLI

**Agent Runtime**:
A capability on a Computer that can execute one implementation such as Claude,
Codex, Pi, or Kimi. `Logical Agent.executorKind` selects the required runtime.
A runtime is not an Agent and never creates one by registering.
_Avoid_: Default Agent, Agent identity

**Placement**:
The active binding of one Logical Agent to one Agent Runtime on one stable
Computer. The current Daemon Node is resolved at dispatch time and may be
replaced without moving or recreating the Agent or Placement.
_Avoid_: Assignment, deployment

**Node-scoped Team**:
A lead and member Agents whose active placements all reference Agent Runtimes
on the Thread's Computer. An unplaced Agent or an Agent on another Computer is
not eligible to join.
_Avoid_: Cross-node team, shared-path team

**Thread Runtime**:
The computer selected when a thread is initialized. The selection is persisted
on the thread, cannot change after the thread starts, and bounds every agent
eligible to participate in that thread.
_Avoid_: Per-turn computer, movable thread

**Thread Workspace**:
The only writable work context. Every Agent participating in one Thread shares
that Thread's workspace; no Agent workspace survives or spans Threads.
_Avoid_: Agent Workspace, shared Computer workspace

**Node Workspace Root**:
Storage configured on a Computer that contains Thread Workspaces. It is not a
workspace, identity, or scheduling boundary by itself.
_Avoid_: Workspace, Agent home

**Project**:
An employee-owned collaboration boundary with one persistent workspace, an
ordered roster of Project Agents, and any number of Project Conversations.
_Avoid_: Folder, Team

**Project Agent**:
A Logical Agent enlisted in a Project with a project-specific role and
responsibilities. The role is an orchestration directive (pipeline stage and
phase); the responsibilities are the agent's outcome contract in prose. A
Project Agent is not a human Project Member.
_Avoid_: Project Member, collaborator

**Project Conversation**:
A Thread that belongs to one Project and therefore shares that Project's
persistent workspace and Project Agent roster.
_Avoid_: Project, room

**Project Owner**:
The employee who owns and can currently access a Project. Human collaborator
membership is a separate future authorization concept, not the Project Agent roster.
_Avoid_: Project Agent, lead Agent
