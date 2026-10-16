# Relay Orchestration

Relay coordinates user-owned agents while keeping execution on registered
computers outside the control plane.

## Language

**User**:
The person who owns agents, computers, threads, tasks, and projects. Stored in
`users`; owner fields read `ownerUserId` / `owner_user_id`.
_Avoid_: Employee (the pre-rename name; old data and daemons are upgraded by
`backend/relay/core/legacy_names.py`), Member

**Account**:
A User's login credential — username, password hash, role, preferences —
stored in `auth_accounts` and pointing at its User through `userId`. Sessions
belong to an Account.
_Avoid_: User (for the credential), Login

**Waitlist Entry**:
A person's request to try Relay, keyed by a normalized email. It is not a User
and owns nothing; an accepted Invite creates the User and Account and links the
entry to that Account (`accountId`).
_Avoid_: Lead, Signup, Applicant, Pending user

**Invite**:
A single-use, expiring credential issued to one Waitlist Entry. Redeeming it
creates an Account; only its SHA-256 is stored, and re-inviting rotates it.
_Avoid_: Invitation code, access key

**Computer**:
The product-facing execution host on which agents are placed and collaborate.
_Avoid_: Machine, worker

**Daemon Node**:
The execution-plane runtime registered for one computer.
_Avoid_: Sandbox, agent

**Logical Agent**:
The durable user-owned identity built on an Agent Runtime through a
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
A lead and member Agents bound to one Computer chosen when the Team is set up
(`computerId`). Every member's active Placement must be on that Computer; an
unplaced Agent or an Agent on another Computer is not eligible to join. A
Thread may address a Team only when the Team lives on the Thread's Computer.
_Avoid_: Cross-node team, shared-path team

**Thread Runtime**:
The computer selected when a thread is initialized. The selection is persisted
on the thread, cannot change after the thread starts, and bounds every agent
eligible to participate in that thread.
_Avoid_: Per-turn computer, movable thread

**Thread Workspace**:
The writable work context of a Thread that belongs to neither a Task nor a
Project. Every Agent participating in that Thread shares it; no Agent workspace
survives or spans Threads.
_Avoid_: Agent Workspace, shared Computer workspace

**Task Workspace**:
The writable work context shared by every round of one backlog Task
(`tasks/<taskId>/`), or of one Automation occurrence
(`tasks/<routineId>/<taskId>/`). It is bound once at first dispatch
(`task.workspace_bound`) and reused by every later round; a Computer without
task-workspace support is refused rather than degraded. A Task in a Project
uses the Project's workspace instead.
_Avoid_: Thread Workspace (for task rounds), round directory

**Node Workspace Root**:
Storage configured on a Computer that contains Thread Workspaces. It is not a
workspace, identity, or scheduling boundary by itself.
_Avoid_: Workspace, Agent home

**Project**:
A user-owned collaboration boundary with one persistent workspace, an
ordered roster of Project Agents, and any number of Project Conversations.
_Avoid_: Folder, Team

**Linked Directory**:
An existing directory on a Project's Computer that the Project uses as its
persistent workspace instead of one Relay creates under the Node Workspace
Root. The Computer decides which directories may be linked; deleting the
Project forgets the link and leaves the directory in place. UI copy calls it
the project's folder — the folder is the directory, never the Project itself.
_Avoid_: Project path, mount, external workspace

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
The user who owns and can currently access a Project. Human collaborator
membership is a separate future authorization concept, not the Project Agent roster.
_Avoid_: Project Agent, lead Agent

**Wait**:
A Task parked at `waiting_for_human` on a person, recorded as its
`waitingRequest`: a `questionId`, a kind — `question` (the agent asked),
`check` (a gate stopped the round), or `budget` (continuation rounds ran out) —
and, for a question, the agent's words and offered answers. It names the
Thread it is answered in. Every surface renders the API's `awaiting`
projection of it rather than re-deriving one.
_Avoid_: Block (a blocked Task is stuck on an impediment, not on a person),
pending decision (a rejected turn's own control)

**Answer**:
A message sent in the Thread a Wait names, carrying that Wait's `questionId`.
It resumes the Task as its next round only while the Task still waits on that
question; an Answer to a replaced question is refused (`question_superseded`).
_Avoid_: Reply (any message), approval
