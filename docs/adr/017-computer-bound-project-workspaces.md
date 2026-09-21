# ADR-017: Computer-bound project workspaces

Status: Accepted

## Context

Relay previously treated every task conversation as an independent workspace. A project needs several conversations to cooperate on the same files, while the execution plane can only guarantee local filesystem access for agents running on one Computer. Project agents also need stable, project-specific responsibilities instead of ad-hoc agent selection on every message.

## Decision

Relay introduces an owner-scoped `Project` aggregate with:

- one immutable stable `computerId`;
- one relative `workspaceSubpath` (`projects/<project-id>` by default);
- one lead agent and an ordered Project Agent roster;
- a required role, function title, and responsibilities for every member;
- versioned, event-authoritative updates and archival.

Tasks and sessions may reference `projectId`. Historical rows remain unclassified; Relay does not infer or backfill projects from filesystem paths.

Every project dispatch resolves the current daemon runtime for the project's stable Computer. A task with an explicit `assignedAgentId` executes only that enabled Project Agent; a task without an explicit assignee executes the enabled roster, lead first. Dispatch re-resolves every selected member placement on that Computer. The backend sends project identity and `workspaceSubpath` to the daemon, but never executes an agent itself. Daemons must advertise `project-workspaces`; older daemons fail closed.

All conversations in a project resolve to the same physical project directory. Runs targeting the same directory are serialized by the daemon workspace gate, while different project directories may run concurrently. The project roster is compiled into each collaboration round, including the project revision and every member's role-specific brief.

The web client exposes the hierarchy `Projects -> Project -> task conversations`, plus an `Unclassified` folder for legacy conversations. Project-room composers do not offer Computer, team, or individual-agent overrides; an explicit mention may address a Project Agent for a turn, while an unaddressed message runs the project room.

In this decision, roster members are Logical Agents, canonically called
**Project Agents**. They are not human collaborators. Project access remains
owner-scoped until a separate employee membership and role policy is defined;
the agent roster must never be reused as an authorization list.

## Consequences

- Moving a project to another Computer is intentionally unsupported; create a new project if the workspace boundary changes.
- A project cannot contain agents placed on different Computers.
- Updating a roster affects future rounds, while prior manifests retain the project revision used for auditability.
- Project files survive across its conversations, so code must treat the physical directory—not the session ID—as the write-concurrency boundary.
- Archiving a project prevents new dispatches but does not rewrite or delete historical tasks, sessions, events, or files.
