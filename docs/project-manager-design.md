# Relay project manager

Status: Implemented. See [verification evidence](testing/project-manager.tdd.md).

Bindings are stored in the existing event-backed Project snapshot. Migration
`20261106_0113` adds proposal projections and authoritative proposal events.
The runtime bridge uses an opaque per-run mailbox and the daemon-held command
lease, authenticated by the node credential outside the Agent workspace. Its
shared command helper supports every existing Agent Runtime. Workspace search
is a bounded text search; it does not build a semantic index.

Every Project has a Relay project manager: a persistent place to ask what is
happening, understand the backlog, decide what to do next, and manage Tasks in
conversation. The manager knows which Project the person is asking about and
retrieves its current records before answering.

The product identity is **Relay**, with the subtitle **Project manager**. Its
execution is backed by a user-owned Logical Agent on the Project's Computer.
The binding, conversation, and memory belong to the Project, even when the same
Logical Agent serves several Projects.

## What a person can ask

| Request | Expected result |
| --- | --- |
| “What is this project trying to achieve?” | Summarize its goal, brief, standing context, and relevant workspace documents, linking sources. |
| “What changed since Monday?” | Summarize recorded Task changes and Agent reports in that time window, with links and an explicit cutoff. |
| “What is left to do?” | Show open Tasks grouped by meaningful next action, including backlog, work awaiting a person, blocked work, and Prerequisites. |
| “What should I work on next?” | Recommend a short ordered list based on readiness, priority, dates, Prerequisites, and available Agents. Explain the ordering. |
| “Break the onboarding work into tasks.” | Draft editable Tasks with acceptance criteria and Prerequisites; let the owner apply the selected Tasks. |
| “Make the login fix urgent and give it to Ada.” | Resolve the Task and eligible Agent, then present the exact assignment and priority changes for Apply. |
| “Start the login fix.” | Present a Start action for the identified Task, using ordinary admission and Task Capacity rules. |
| “Why is this task stuck?” | Distinguish a Prerequisite, Wait, impediment, capacity queue, unavailable Computer, and execution requiring recovery; link the actual next action. |
| “Remember that releases require a migration check.” | Propose an addition to standing Project context for the owner to adopt. |

“Todos” maps to existing Tasks. A checklist in an answer becomes tracked work
only when applied as Tasks. Relay must not maintain a competing private backlog.
“Any project information” means information Relay can access in this Project;
unconnected services and unrecorded conversations remain unknown.

## Manager identity and defaults

Add a Project Manager binding with `managerAgentId` and a canonical
`managerThreadId`. This is a Project responsibility, separate from the existing
Agent Role vocabulary and `leadAgentId`. The lead still coordinates roster work;
selecting a manager does not change Task assignment or the roster pipeline.

For a new Project, use its eligible lead as the initial manager; otherwise use
the first eligible Agent ordered by creation time and ID. Default Agents are
ordinary Logical Agents and follow this same ordering. Show the selected name during
creation with an optional Change action. Do not create runtime-specific Agent
clones for every Project. An Agent outside the roster may serve as manager under
the existing same-Computer rule; Direct Delegation remains roster constrained.

Every Project gets the manager entry point, including Projects without a crew
and Linked Directory Projects. If no Agent qualifies, show “Choose an agent for
Relay” with eligible choices or a link to Agent setup. This is a configuration
state, not a fictitious available assistant. Once selected, never silently
switch to another Agent because the current one is busy, offline, moved, or
disabled. Offer Change agent with the reason and preserve history.

Eligibility requires the same owner, an enabled Logical Agent, and an active
Placement on the Project's Computer. A disabled roster entry cannot be selected.
Dispatch additionally checks live runtime readiness and required capabilities.
Changing the manager applies to the next turn; an active turn pins its Agent
and binding revision. The UI records who actually answered as “Relay · via Ada”.

## Project experience

Keep the existing Dashboard, Tasks, Automations, Workspace, Agents, and Settings
surfaces. Add a prominent **Ask Relay** action in the Project header and a compact
manager entry on the Dashboard. Opening it reveals the canonical manager
conversation with the current Project name visible. Do not replace the dashboard
or force a conversation to read the board.

On desktop, use a resizable side panel so Task links can open the existing Task
drawer while keeping the conversation accessible. On mobile, use a full-width
conversation view; Back returns to the prior Project tab and scroll position.
Use the addressable Project view at
`/projects/{projectId}?manager=open`, consistent with canonical URL handling.
The underlying Thread remains available through existing Thread navigation.

The initial conversation offers “Project update”, “What needs me?”, “Next tasks”,
and “Plan work”. These are ordinary editable prompts. Opening the panel does not
start an Agent run. “Project update” defaults to the last seven calendar days
in the person's timezone and displays the exact range; the person can change it.

Answers lead with the useful conclusion, then links to Tasks, Threads, decisions,
and files. A status answer separates recorded facts from Agent reports and
recommendations. For example: “Two Tasks need your input. The API Task is waiting
on your answer; the release Task is awaiting review.” A successful Agent run is
not proof that the requested outcome was accepted.

Task changes appear as an inline card with target links, before/after values,
editable fields, and **Apply changes** / **Dismiss**. A plan supports selecting
individual proposed Tasks. Apply is the owner's mutation request; there is no
second generic confirmation dialog. Starting work, accepting a Task Review,
answering a Wait, and reconciling execution retain their existing specific
actions and requirements. Relay links to those flows instead of treating them
as ordinary status edits.

Preserve existing visual tokens and chat components. Support keyboard access,
named controls, announced asynchronous results, English and Simplified Chinese,
long translated labels, and light/dark themes. Keep input reachable on short
mobile screens. Retain ordinary Thread stop, retry, Permission Prompt, and
recovery controls.

## Information and memory

The source of truth is the existing event-backed Project, Task, and Thread
records. At every manager turn, build a bounded Project overview containing the
brief and context revision, roster and manager identity, Task counts, attention
items, recent changes, and Computer availability. Include a read timestamp and
source revisions. Full records and older history are retrieved on demand.
Use a consistent database snapshot for each overview and an event watermark for
activity pagination. Later tool reads identify their own revision/time; if a
material fact changes during a turn, refresh it before making a recommendation.

Provide Project-scoped read operations for overview, filtered/paginated Tasks,
Task details and review evidence, activity by time range, relevant Thread
messages, and workspace search/read. Return stable cursors, deterministic
ordering, source links, and coverage metadata. Counts cover the full authorized
set; truncated samples must never be described as the entire backlog. Keep
Automation definitions distinct from their generated Tasks.

Task activity comes from persisted history rather than an Agent's recollection.
Workspace access goes through daemon workspace commands on the Project's
Computer, including Linked Directory mappings. Workspace text and Agent reports
are source material, not authority to change instructions or permissions. File
search is an explicit implementation addition; current workspace listing/read
alone does not provide semantic search over the whole Project.

Memory has three layers: authoritative live records; owner-adopted standing
Project context; and a bounded conversation summary carrying decisions and
source references. The summary is a retrieval aid and never overrides live
status. Propose durable lessons through the existing context suggestion flow.
Changing manager Agent retains the Project's context and conversation. New
turns retrieve current records even after a long conversation is compacted.

No model runs continuously. Task updates become visible to the next read without
an Agent run for every event. Scheduled digests can later use an explicit
Automation; they are outside the first release.

## Applying task changes

Use typed, persisted proposals, not executable prose. The initial operation set
is Task creation, title/description and acceptance-criteria edits, priority,
due date, tags, assignment, and Prerequisites. Unclear Task references, relative
dates, or ambiguous Agent names require a focused clarification before staging.
Display normalized dates in the owner's timezone.
Keep acceptance criteria in the Task description initially; this does not
change the Task's acceptance policy or bypass Task Review.

Each proposal records its Project, proposing Agent/run/Thread, source message,
operations, expected revisions, and state: `pending`, `applied`, `dismissed`,
`superseded`, or `expired`. Applying records the owner, timestamp, resulting
entity IDs, and emitted event references. Regenerating supersedes the old
proposal. Selecting/editing a subset creates a validated application payload
with its own idempotency key; the card shows exactly which items were applied.

The backend rechecks ownership, Project membership of every target Task,
assignment eligibility, prerequisite cycles, and current revisions under locks.
Apply a metadata/plan batch in one database transaction through the ordinary
domain operations. A stale or invalid operation rejects the batch without
partial changes; refresh and show the changed values for a revised proposal.
Persist the application result with the idempotency key in that transaction so
repeated clicks or network retries return the same result and created IDs.

Creating a Task leaves it in backlog. It does not queue or start work, preserving
the current Project Plan contract. A requested Start is a separate explicit
action through normal Task dispatch, and may result in Queued due to capacity.
Never promise a process has started merely because a request was accepted.
Task deletion, cancellation, review acceptance, and execution reconciliation use
existing dedicated flows in this release. Suggestions can link to those flows.

## Runtime and API design

All API names here are under `/api/v1`; implementation behavior is linked
below. Keep orchestration in Python and execute the manager through
`CollaborationConductor` and the ordinary daemon queue.

| Surface | Contract |
| --- | --- |
| `GET /projects/{id}/manager` | Binding, effective configuration/availability, existing Thread ID, and manager capability availability. A read creates no Thread or run. |
| `PUT /projects/{id}/manager` | Owner selects `agentId` with expected Project version. Does not rewrite the lead or roster. |
| `POST /projects/{id}/manager/messages` | Lazily ensure the canonical Thread and submit an idempotent message, returning Thread/run identity. |
| `GET /projects/{id}/manager/overview` | Bounded factual projection with timestamps, source revisions, totals, and coverage. |
| `POST /projects/{id}/manager/proposals/{proposalId}/apply` | Apply owner-selected operations with expected proposal revision and idempotency key; return affected records. |
| `POST /projects/{id}/manager/proposals/{proposalId}/dismiss` | Settle a pending proposal without changing Tasks. |

Manager messages target only the configured manager unless the owner explicitly
addresses another eligible Agent. This route overrides the existing bare
Project message behavior that selects the crew. Other Project Conversations and
Task Threads retain their existing routing. A manager turn has Thread scope;
it does not acquire execution ownership over any Task it discusses.

Use the authenticated run-scoped daemon tool bridge for the read operations and
proposal staging. The daemon retains the opaque command lease and node credential;
the server checks its active command, manager Agent, Project, canonical Thread,
and allowed operation set on each invocation. Do not expose
browser cookies or node credentials inside the agent sandbox. The daemon holds
the backend credential and provides a local invocation interface to its Agent
Runtime. Validate that the bound command is still active on each call, revoke
on completion/cancellation, and reject cross-Project IDs regardless of prompt
content. Only the authenticated owner can apply a proposal. Agent tools cannot
invoke owner apply endpoints.

Advertise a new daemon capability for manager tools. Show a client update action
when it is missing; never simulate successful tools or silently fall back to
workspace-only answers. Implement an adapter for each supported Agent Runtime;
release availability follows verified adapter support, not just Computer online
state. This bridge is new work; Project snapshots alone do not provide live
backlog access or Task management.

## Persistence and lifecycle

Persist nullable manager Agent/Thread references on Projects, with an event for
binding changes. Add proposal/application records and indexes for Project,
Thread, pending state, and idempotency lookup. References and snapshots change
together with their authoritative events. Use Alembic for schema changes.

Backfill bindings deterministically using the selection policy above, without
creating conversations or dispatching runs. Projects lacking an eligible Agent
remain visibly unconfigured. Create the canonical Thread under a Project row
lock on the first message so concurrent tabs cannot create competing canonical
Threads. Serialize active turns with existing Thread run admission; a second
message sees Busy with retry rather than launching a competing run.

Changing the manager during a run does not transfer that run or authorize its
pending proposals differently. Applying always validates current authority and
revisions. If the canonical Thread is deleted, clear its binding and lazily
create the next one; retain existing adopted Project context and proposal audit
records according to record retention. Do not silently replace a deleted Agent.

Archived or disabled Projects retain readable history and recorded overview but
cannot start manager turns or apply pending proposals. Restore requires renewed
validation. Project deletion includes the canonical Thread, in-flight execution,
and proposals in the ordinary deletion/recovery checks. Deleting a Linked
Directory Project still leaves its directory in place.

## Delivery and acceptance

Implement the complete initial experience in these dependent slices:

1. Binding, migration/backfill, canonical conversation, manager-only routing,
   availability, and existing Thread execution controls.
2. Authorized read bridge, fresh overview and activity retrieval, source links,
   pagination, and conversation memory. Ship together with verified runtime
   adapters before claiming project-wide answers.
3. Typed proposal staging, editable cards, transactional owner apply, and links
   to Start, Wait, review, and recovery actions. Read-only chat alone does not
   fulfill the task-management feature.
4. Project entry points, URL/cache behavior, translations, responsive layout,
   and integration verification across the three slices.

The initial release is complete when the following scenarios pass:

- A new, existing, crewless, and Linked Directory Project each has a visible
  manager; missing configuration has a real recovery path. Opening it runs no
  model, and concurrent first messages create one canonical Thread.
- Ask about goal, updates, backlog, todos, and next work. Answers use current
  records with usable source links. A Task changed in another tab appears on
  the next read; a large Project is not silently summarized from one page.
- Draft Tasks and edit assignment, priority, due dates, and Prerequisites in
  conversation. Apply changes once, observe the ordinary event history and
  board update, and verify that newly created Tasks have not started.
- Duplicate Apply creates no duplicate Tasks. Stale revisions, invalid
  assignments, and prerequisite cycles leave the entire batch unchanged.
- Another owner's Project, Task, Thread, or file cannot be read or changed by
  forged IDs, an admin role, tool calls, or a credential from another run.
- Offline, busy, moved, disabled, unsupported, archived, and deleted states
  produce accurate outcomes and retain execution stop/recovery paths. Recorded
  data remains readable offline; fresh manager inference waits for execution
  availability rather than running in the backend.
- Waits, queued work, reported completion, accepted work, and lost execution
  remain distinct. A status answer cannot accidentally finish a linked Task.
- Manager, Task drawer, and Project navigation work with keyboard and mobile
  layouts in both supported languages. Mutations invalidate Project, Task,
  overview, and proposal caches; SSE/poll responses cannot overwrite newer data.

Use backend API/domain tests for access, transactions, lifecycle, and event
history; daemon/protocol tests for tool credential scope and runtime adapters;
web tests for proposal/cache behavior; and end-to-end tests for ask, source
navigation, edit/apply, concurrent tabs, and recovery. Run layering, schema drift,
module-size, and route-auth checks with implementation changes.

## Implementation anchors

Current behavior to reuse or extend:

- [Domain glossary](../CONTEXT.md): Project, Logical Agent, Project Conversation,
  Project Plan, Project Manager, Wait, Task Review, and Task Capacity.
- [Project routing and snapshots](../backend/relay/projects/runtime.py) and
  [context rendering](../backend/relay/projects/context.py).
- [Project API](../backend/relay/api/projects/projects.py),
  [plan application](../backend/relay/api/projects/plan.py), and
  [Project store](../backend/relay/persistence/project/store.py).
- [Task updates](../backend/relay/tasks/update.py) and
  [delegation eligibility](../backend/relay/agents/delegation.py).
- [Project page](../web/src/components/ProjectWorkspacePage.tsx) and
  [Dashboard](../web/src/components/ProjectDashboard.tsx).
- [ADR 024](adr/024-task-prerequisites-and-project-plans.md): proposals,
  Prerequisites, transactional apply, and owner-controlled starts. The new
  manager extends these contracts; it does not replace them.
