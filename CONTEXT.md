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
creates an Account; only its SHA-256 is stored, and re-inviting rotates it. An
admin can invite an address that never asked; it still gets a Waitlist Entry,
so one address has one invite at a time.
_Avoid_: Invitation code, access key

**Password Reset**:
A single-use, expiring credential issued to one Account that lets whoever holds
it set that Account's password once; redeeming it signs every session out and
signs nobody in. Only its SHA-256 is stored, and issuing a new one retires any
earlier one for the same Account.
_Avoid_: Recovery token, reset code, magic link

**Computer**:
The product-facing execution host on which agents are placed and collaborate.
_Avoid_: Machine, worker

**Daemon Node**:
The execution-plane runtime registered for one computer.
_Avoid_: Sandbox, agent

**Outdated Client**:
A Computer whose Daemon Node did not advertise every capability this backend
knows at its last registration — it runs an older Relay client than the server
ships. Derived on read (`clientOutdated` on node records), never stored.
_Avoid_: Old version, stale daemon (stale means it stopped heartbeating)

**Notification**:
A notice in one person's inbox that something they own changed while they may
not have been looking: a Task they own or are assigned finished
(`task_completed`), a team awaits their approval before its next step
(`approval_requested`), a Computer they hold went online or offline
(`computer_status`), or a Computer runs an Outdated Client
(`client_outdated`). Shared hardware no User holds notifies every admin. It
carries facts, not prose; muting a kind hides its notices without deleting
them.
_Avoid_: Alert, message (a Thread message), event (an event-log record)

**Logical Agent**:
The durable user-owned identity built on an Agent Runtime through a
Placement. Its configuration is independent of the computer that executes it,
and it does not own a workspace.
_Avoid_: Executor, CLI

**Agent Role**:
The part a Logical Agent plays in a shared round. Stored and sent by id
(`planner`, `implementer`, `reviewer`, `tester`, `fixer`), shown to people and
agents by title: Architect, Software Engineer, Code Reviewer, QA Engineer, Bug
Fixer. Each role carries a charter (`backend/relay/core/role_charters.py`)
saying what it delivers and what it leaves to the others. A round's lead is a
coordinator, not a role. An agent has its own role, chosen at setup and
editable on its profile; a Team records a role for each member, starting from
the agent's own when it joins, and plays that one — changing the agent's role
later leaves the team's choice alone.
_Avoid_: Tech Lead (for the planner), job, persona

**Agent Runtime**:
A capability on a Computer that can execute one implementation such as Codex,
Claude, Pi, OpenCode, or Kimi. `Logical Agent.executorKind` selects the required runtime.
A runtime is not an Agent and never creates one by registering. A connecting
Computer *offers* a **Default Agent** per ready runtime — an ordinary Logical
Agent named after the runtime — and its User accepts or declines each, once
per Computer and runtime. Computers enrolled before the offer existed were
seeded once, unasked.
_Avoid_: calling the runtime itself the Default Agent, Agent identity

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

**Thread Records**:
The `.relay/threads/<threadId>/` directory inside a Thread's bound workspace,
beside Relay's other control files in `.relay/`. `HANDOFF.md` records status,
progress, decisions, blockers, and next actions; `HANDOFF.json` is the
structured handoff checkpoint. Automation runs share one pair of handoff files
at `.relay/threads/<routineId>/` in their bound workspace, so later runs read
and update the same checkpoint. Other Threads have their own records even when
several Threads share a Task or Project workspace. Older runs left them in
`.threads/<threadId>/` or `threads/<threadId>/`; the daemon moves them on the
Thread's next run.

**Artifacts Directory**:
Where a run writes generated deliverables, relative to its bound execution
workspace. A standalone Thread uses `<threadId>/artifacts/`; a backlog Task
uses `tasks/<taskId>/artifacts/`; each Automation run keeps its own
`tasks/<routineId>/artifacts/<taskId>/` inside the one Automation directory its
runs share. A Project has no artifacts directory: the Project workspace itself
(including a Linked Directory) is the deliverable location, and files go where
they belong in it. The backend names the directory on every `run.start`
(`artifactsDir`, null for a Project); a Computer without the `artifact-layout`
capability keeps the older per-run Automation directory and an `artifacts/` in
every workspace. Source code stays in its project location. Existing files keep
their paths; this convention guides new deliverables rather than moving files
that may already be referenced.

**Task Workspace**:
The writable work context shared by every round of one backlog Task
(`tasks/<taskId>/`), or by every run of one Automation (`tasks/<routineId>/`,
with per-run Artifacts Directories under it). It is bound once at first
dispatch (`task.workspace_bound`) and reused by every later round; a Computer
without task-workspace support is refused rather than degraded. A Task in a
Project uses the Project's workspace instead.
_Avoid_: Thread Workspace (for task rounds), round directory

**Node Workspace Root**:
Storage configured on a Computer that contains Thread Workspaces, each under
its `.threads/<threadId>/` directory. It is not a
workspace, identity, or scheduling boundary by itself.
_Avoid_: Workspace, Agent home

**Project**:
A user-owned collaboration boundary with one persistent workspace, an
ordered roster of Project Agents, and any number of Project Conversations.
_Avoid_: Folder, Team

**Linked Directory**:
An existing directory on a Project's Computer that the Project uses as its
persistent workspace instead of one Relay creates under the Node Workspace
Root. This is the existing-project creation path: such a Project keeps the
name, brief, and roster its owner gives it, so setup drafting is offered only
for fresh projects, while planning further work is offered for either. The
Computer decides which directories may be linked; deleting the
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

**Prerequisite**:
A Task in the same Project that must be done before another Task may run.
A Task waiting on one keeps its status; "waiting on" is derived, never stored.
_Avoid_: Blocker, dependency link, parent task

**Project Plan**:
An ordered list of proposed Tasks, with their Prerequisites, that a Project's
lead drafts on request. Nothing changes until the Project Owner applies it.
_Avoid_: Planner agent, roadmap

**Project Owner**:
The user who owns and can currently access a Project. Human collaborator
membership is a separate future authorization concept, not the Project Agent roster.
_Avoid_: Project Agent, lead Agent

**Tag**:
A free-form label a person files a Task or Automation under, to group and
filter them. Tags are compared case-insensitively and carry no behaviour of
their own; an Automation's tags are copied onto every Task it fires.
_Avoid_: Label, category

**Wait**:
A Task parked at `waiting_for_human` on a person, recorded as its
`waitingRequest`: a `questionId`, a kind — `question` (the agent asked),
`check` (a gate stopped the round), `budget` (continuation rounds ran out), or
`approval` (the Team stopped before its round's final step for its person to
approve) — and, for a question, the agent's words and offered answers. It names the
Thread it is answered in. Every surface renders the API's `awaiting`
projection of it rather than re-deriving one.
_Avoid_: Block (a blocked Task is stuck on an impediment, not on a person),
pending decision (a rejected turn's own control)

**Answer**:
A message sent in the Thread a Wait names, carrying that Wait's `questionId`.
It resumes the Task as its next round only while the Task still waits on that
question; an Answer to a replaced question is refused (`question_superseded`).
An Answer to an `approval` Wait approves the held step (`approve: true`) or,
written, asks for changes; either resumes the same round rather than starting
a new one.
_Avoid_: Reply (any message)

**Permission Prompt**:
A live run paused before a tool call, asking a person to allow or deny it
(`permissionRequests` on the Thread). Unlike a Wait, the run is still
executing and no Task changes status; it closes once — allowed, denied, or
expired when its run ends first. Only a local computer with the native
permission policy produces one; every runtime asks through its own adapter
on one broker.
_Avoid_: approval request, pending approval (both read as a turn decision),
Wait
