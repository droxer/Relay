# Project Team workflows

Status: first-release product scope approved by the owner on 2026-11-16;
W1 backend definition foundation, W2a/W2b dedicated workflow execution, W2c
client event parity and the dedicated W3 web surfaces are implemented. W4 now
includes loopback backend/daemon acceptance with a deterministic Agent Runtime.
Approved Task entry and Task-details timeline are now implemented and covered by
API, real daemon and browser acceptance. Native 200% browser zoom remains unverified.
This document records the implementation backlog and milestone boundaries.
No Project Tasks or Automations were created.

## Current delivery status

Use this table for current readiness. The dated checkpoints below describe
individual contributions; statements such as "no production producer" apply
only to their checkpoint and are superseded by the W2a/W2b adapters below.

| Capability | Current boundary | Remaining acceptance |
| --- | --- | --- |
| Project Team definition | Backend save/validation plus the Project Agents-tab editor (ordered step cards, button/menu reorder, independent optional approval gates). | Real-backend save/reload in W4. |
| Frozen workflow and human decisions | Backend decisions plus the thread composer slip (approve/reject, retry, cancel behind confirmation), bound to the shown attempt and revision. | Real-backend decision races in W4. |
| Sequential execution | Dedicated workflow adapter runs saved order, checks recorded outputs, gates successors and preserves exit/reconciliation reservations. Real daemon integration now covers four steps, failed verification/retry, approval, restart, frozen edits and cancellation using a deterministic runtime. Generic unsupported entry paths remain guarded. | Task entry now shares the ledger and preserves one Task execution generation across gates/retries. Model-provider execution has not been tested. |
| Browser state and controls | W2c: exact client projection for computable events; step results and retries refetch the snapshot (fixture pinned by `test_workflow_client_parity.py`). W3: start from the Project, sticky thread progress with timeline. | Task pickers allow matching-Project workflows; Task Activity shows all frozen ledgers and attempts. Generic composer addressing remains guarded. |
| Themes and device sizes | Built-export mocked-API sweep passes light/dark × all seven sizes. Dedicated progress row and scrollable decision slip fix short-screen overlap. Live light/dark/system switching, save and all decision controls pass clickability checks at 320×568, 844×390 and 640×450/DPR 2. | 640×450/DPR 2 simulates 200% desktop reflow; native browser zoom remains unverified; real browser-to-backend Task start/retry/approval/completion now pass. |
| Production build | Core/daemon/supervisor compile; web static export passes `npm run build -w web -- --webpack`, and compiled test sources pass TypeScript. | Default full `npm run build` still encounters a Turbopack local process/port EPERM, including escalated retry. Webpack verification does not conceal that limitation. |

Task workflow integration is complete; remaining acceptance is native browser zoom. W2b requester review passed
the 12-file focused regression (210 tests), backend Ruff and mypy (486 files).
No additional product-scope approval is needed. Backend runtime completion does
not certify the workflow UI or the feature as release-ready.

### Task integration verification — 2026-11-16

The dedicated `tasks/workflow.py` adapter freezes and links the Task's ledger
with an execution generation in one transaction. Gates and step failures park the
same request; retry preserves ownership. Publication failure rolls back the
ledger/link/claim and records an actionable blocker. Admission locks the Task
through command publication and rejects stale generations. Reconciliation retains
the generation and requires explicit retry. Completion honors human acceptance.

Task selectors offer workflow Teams only in their matching Project. Task Activity
shows every linked workflow, default-expanded, with per-attempt outputs, evidence,
notes, timestamps and owner decisions. Blocked workflow Tasks open the existing
Thread controls rather than attempting a second Task execution. Legacy collaboration
style controls are hidden for workflow assignments.

Real browser acceptance used the exported app, loopback Python backend and actual
TypeScript daemon with the deterministic runtime: Task start, verification failure,
retry, deployment approval and completion. The real-daemon regression also covers
backend restart, frozen Team edits and cancellation. Native keyboard zoom did not
change the browser's measured zoom, and native input automation timed out; do not
claim native 200% acceptance from the equivalent reflow check.

### Independent W4 repairs — 2026-11-16

`backend/tests/api/test_workflow_daemon_e2e.py` exercises a real loopback HTTP
backend and the actual TypeScript daemon, substituting only the Agent Runtime.
It exposed two production defects missed by direct registry-result injection:
workflow command state lacked `initial_agent_state` defaults (the runtime
crashed reading `agent_failures`), and the daemon consumed the verdict's `runId`
without forwarding it to the backend's workflow validator. Both are repaired;
`workflow-results` gates older daemon clients that cannot forward that binding.
The updated installer manifest advertises the capability with registration.
The two integration cases pass, including verification failure/retry, gated
deployment, backend restart, frozen Team edits and active cancellation.

The full backend run then exposed a poll/start lock inversion: workflow entry
held SQLite's writer reservation while waiting for a node scope that a poll
held while waiting to write. Workflow start, owner decisions, admission,
recovery and progression now take the global/node scopes before their write
transaction. A deterministic concurrency regression holds a poll's node scope
and proves it can still write liveness while a workflow start waits.

The timeline now preserves each recorded attempt's result and failure reason
after a successful retry. Its regression failed before the fix and passes
afterward. Progress has its own responsive grid row so transcript autoscroll
cannot hide it; long owner decisions scroll within a bounded slip. The complete
14-case theme/size matrix and additional button trial-click checks pass.
These checks do not complete the approved Task integration or authorize a PR
claiming the whole feature is ready.

### Acceptance handoff — 2026-11-16

The owner approved all six frontend recommendations and requested verification
before a PR. Do not reopen those decisions. W3 is implemented for the dedicated
Project-to-Thread entry, but two approved Task surfaces remain incomplete:
`AssignmentField`/`AgentSelect` exclude workflow Teams while the backend rejects
generic assignment, and the complete timeline lives in the Thread rather than
Task details. These are delivery gaps, not approved scope reductions. Keep the
guards until Task dispatch has the same workflow admission and recovery policy.

Next bounded work: independently verify the dedicated entry through a real
backend and daemon, then report Task integration separately. Acceptance evidence
must identify the actual environment and distinguish a real agent run from a
mocked API or a directly injected registry completion:

1. Save/reload design → development → verification → deployment in the Project
   editor, including repeated assignees; edit the Team during a run and confirm
   its frozen definition remains unchanged.
2. Observe real daemon execution in order and recorded predecessor outputs.
   Failed verification must create no deployment command; retry must wait for
   exit evidence and use a new attempt. Deployment must wait for explicit owner
   approval; stale/duplicate decisions must not dispatch twice.
3. Cancel an active run, refresh and restart the local test backend, and confirm
   persisted progress and reservations follow the exit/reconciliation contract.
4. Complete 200% browser zoom and live system-theme switching, checking reachable
   editor footers and decision controls. Preserve the seven-size light/dark
   matrix; record the known short-screen progress-strip overlap explicitly.
5. Run the full build and relevant suites; repair reproducible defects within
   these surfaces. Do not claim release acceptance while any case is untested.

Fresh scoped regression: the 14 workflow/store/parity/layering/module-size files
passed **299 tests** (151 warnings) in 15.76 s. Log:
`/tmp/relay-workflow-858ddf-focused.log`. This is backend regression evidence,
not daemon/browser acceptance. Full `npm run build` and its escalated retry
failed in Next.js CSS processing with process creation / local port binding
`EPERM`; logs `/tmp/relay-workflow-858ddf-build.log` and
`/tmp/relay-workflow-858ddf-build-escalated.log`. No full-build pass is claimed.

## Approved behavior

A user builds reusable Teams within one Project from its enabled Project
Agents. The user defines a sequential list of named steps, with one responsible
Agent, instructions and acceptance criteria per step. One
Agent may own several steps. Step names do not extend the Agent role vocabulary.
The Team and every participant remain on the Project's Computer.

Only the signed-in Project owner manages the definition and approves, retries
or cancels its execution. Agents cannot approve their own work. Approval grants
no credentials or additional deployment authority. Human participants,
parallel branches and cross-Computer execution are outside this release.

Each step may require approval before it starts. Deployment steps default to
requiring approval; approval is explicit for each run and current attempt.
Failure, rejection or missing completion evidence prevents downstream execution.
The owner may retry the current step or cancel; retries wait for prior execution
exit evidence or recorded human reconciliation. No automatic repair loops or
rollback. Acceptance criteria guide work; they do not certify correctness.

Starting a run freezes its workflow definition. Subsequent Team edits affect
new runs. Removing or disabling an assignee blocks its future dispatch, keeps
the original evidence, and permits cancellation without silent substitution.

## Baseline implementation boundary (before W1)

- `persistence/team/store.py` stores owner-scoped Teams and authoritative Team
  events. It currently has no explicit Project association or arbitrary steps.
- `api/agents/teams.py` handles owner/admin Team writes;
  `teams/computer.py` checks shared Computer placement. Project-owner-only
  workflow changes must cover admin routes too, not just the normal editor.
- `teams/dispatch.py` builds assignments and snapshots; collaboration styles
  determine role order. `collaboration/manifest.py` records sequential work
  dependencies. Neither fact proves arbitrary workflows are supported.
- Task dispatch and conversation dispatch both consume Team assignments.
  Workflow isolation must hold on both paths, including follow-ups/recovery.
- Existing `humanApproval` behavior is not evidence of per-step approval.

These facts were inspected at revision
`8201bfc597511197f935699610df7b1ac930a3b7`.

### W1 review checkpoint — 2026-11-16

Project association and ordered workflow definitions now persist in existing
Team snapshots/events without a schema migration. Owner-session-only writes,
live Project roster/Computer validation and immutable Project association are
implemented. Task and conversation execution deliberately reject workflow Teams
until W2 supplies their execution policy. Legacy Teams retain their old paths.

Primary review independently reran the workflow/store/profile/layering/size
suite: 80 passed. Backend Ruff and mypy passed (476 source files). Full build
compiled core, daemon and supervisor and generated the installer bundle, then
failed at Next.js CSS processing with local port EPERM, including an escalated
retry. This is incomplete build evidence, not feature release acceptance.

### Relationship to existing decisions

[ADR-019](../adr/019-team-work-acceptance.md) defines evidence-based acceptance
and bounded repair; [ADR-021](../adr/021-team-collaboration-styles.md) permits
later Pipeline steps to run despite a missing predecessor report. The approved
workflow mode deliberately changes those two policies: stop immediately and
require owner-directed retry. Keep those ADRs' behavior for legacy styles;
record the workflow-specific exception in an ADR when W2 implements it.

[ADR-023](../adr/023-style-templates-and-human-steps.md) is proposed and only
partially implemented. Reuse its shipped compiler/approval foundations where
appropriate, but its proposed role selectors, human assignee steps, graph
repair targets and "mark done" shortcut do not define this release. The
approved release pins each step to a Project Agent and does not let a gate
answer bypass required work/output. Do not accidentally inherit automatic
repair or final-turn-only approval from the existing style machinery.

## Implementation backlog and dependencies

### W1: Project association and workflow contract

Owners: `persistence/team/`, `teams/`, `api/agents/teams.py`, Project access
helpers, schema/migrations if needed. Update `CONTEXT.md` and API documentation
with the actual implemented contract. Prefer existing event/store mutations.

Add an explicit immutable Project association for workflow Teams and a bounded,
ordered step definition with stable step ids. Validate unique step ids,
nonempty names/instructions, responsible Agent membership,
acceptance criteria and a boolean approval requirement. Preserve repeated
assignees. Reject malformed input rather than dropping unknown workflow fields
and returning success. Normalize before persisting; reads must preserve order.

At save and dispatch boundaries, enforce live Project ownership, enabled Project
membership and Computer placement. A foreign Project, standalone Task or
different Computer cannot use a Project-bound workflow Team. Cover admin writes
and service/Agent actors: being an admin or Project Agent is not workflow-owner
approval authority. Preserve legacy Team behavior and avoid converting records
implicitly. Do not let Project association be removed to bypass isolation.

Acceptance:

- Save, reload and update design -> development -> verification -> deployment,
  including two steps assigned to the same Agent; record Team events.
- Reject malformed/duplicate steps, nonmember/disabled/foreign-owner Agents,
  wrong Computer, foreign Project and unauthorized writes with no stored change.
- Reject reassignment of a workflow Team to another Project and attempts to
  remove Project association while retaining workflow semantics.
- Legacy Team store/API/dispatch tests retain their behavior.
- Until W2 supports execution, workflow Teams fail closed before any daemon
  command, including Task and conversation entry points. Do not silently route
  through the old role order or advertise this milestone as runnable workflows.

### W2: Sequential execution, gates and recovery (requires W1)

Owners: `teams/dispatch.py`, `collaboration/`, `daemon_registry/`, Task dispatch,
session event reducers and decision APIs. Backend queues daemon commands only.

Compile one work item per step in the saved order with stable step identity and
a separate attempt identity. Snapshot the definition into the run; do not look
up the latest definition to interpret an existing attempt. Pass recorded
predecessor outputs to the successor. Require structured success and required
recorded outputs before progression. Keep authoritative step/attempt/gate
transitions in the session/task event stream and materialize through stores.

Use owner-authenticated decisions bound to run, step and attempt. Approval,
retry and completion races must be idempotent: an old or duplicate approval
cannot release a later attempt. Do not introduce a new execution path or
release a delivered reservation without exit evidence/reconciliation.

Acceptance:

- Actual daemon commands follow saved step order even when role order differs
  and the same Agent owns multiple steps.
- A gate before the first step or any later step prevents its command until
  current-attempt owner approval. Gates are explicit and off by default for
  every step; steps have no predefined type.
- Failure/rejection/missing output prevents all downstream commands; retry or
  cancel is available. Retry cannot overlap the previous execution.
- Duplicate/stale decisions and completion replay cannot dispatch twice.
- Editing/reordering a Team during execution preserves the run snapshot;
  a new run sees the updated definition.
- Restart/refresh preserves progress and approval waits. Disabled/removed
  assignees block future dispatch with actionable recovery and cancellation.

### W2 partial implementation checkpoint — 2026-11-16

`collaboration/workflow_compilation.py` now compiles a detached workflow
snapshot into one required assignment per saved step, preserving repeated
assignees and per-step approval gate flags. Work-item identity is stable
within the run; assignment identity changes per retry attempt. It copies only
Agent/routing fields from the roster, excluding legacy planning/repair authority.
The helper allocates identities; it does not authorize retries or dispatch.

The compiler is not yet connected to durable command execution. Subsequent
contributions added session workflow event materialization, owner-only gate
decisions and first-step gate staging (see the thread verification record).
Staging creates a frozen Project Thread and `workflow.started`, with no command
or execution reservation. Approval records readiness; it does not start an Agent.
W1 execution guards remain in place. Durable request delivery, required-output
transport, sequential progression and retry recovery are still pending.
The work-graph manifest adapter now validates the frozen sequence and preserves
step identity separately from retry identity, acceptance criteria and gate flags.
It rejects mixed runs, reordered steps, altered contracts and legacy fallback;
this compiler alone does not provide durable execution or gate authorization.
The legacy approval adapter cannot approve a first step; its index-only approval
must not be reused for workflow attempts. Later staging and decision endpoints
are documented in `docs/api.md`; they do not establish runnable workflows.

27 compiler unit cases pass, including saved order, repeated assignees,
snapshot isolation, retry identity, malformed identities and legacy authority
exclusion. These tests do not prove daemon delivery, database replay, concurrent
decisions or authenticated gates. Those remain mandatory W2 acceptance tests.

### Remaining execution slices — 2026-11-16 scope reconciliation

These are implementation handoffs under the existing owner approval, not new
scope questions or Project Task mutations. Complete them in dependency order.

| Slice | Owning surfaces | Observable completion evidence |
| --- | --- | --- |
| W2a: durable admission | `daemon_registry/dispatch/`, decision API, persisted run requests | Link the frozen run/current step/attempt/revision to a durable request. A pending gate yields zero commands; a current owner approval yields exactly one command after live roster/Computer checks. Concurrent approvals and restart replay cannot duplicate it. |
| W2b: progression and recovery | `daemon_registry/runs/`, `collaboration/`, session events, Task dispatch | A real four-step run preserves saved order and repeated assignees. Structured success and required recorded output release only the next step. Failure/missing output/rejection blocks it; retry waits for exit evidence or human reconciliation; cancellation preserves delivered reservations until that evidence. |
| W2c: client event contract | `packages/relay-core/`, web types and SSE/poll materialization | Python and TypeScript materialize identical recorded workflow events. Replays, stale polls and refresh cannot erase approval waits, attempts or outputs. |
| W3: usable Project workflow | Project/Team/Task editor and run timeline, web API/hooks | Save/reload, Task assignment, current-attempt approve/retry/cancel and validation states work through the supported runtime, with the theme/device matrix below. |
| W4: release evidence | Backend, daemon/core and browser tests; production build | Record exact passing commands, real execution/refresh/restart evidence and theme/device screenshots plus interactions. A partial backend suite or compiler-only test is not end-to-end acceptance. |

Keep execution guards until W2a/W2b support the affected entry/recovery paths;
removing a guard alone is not an implementation slice. The current first-gated
staging endpoint does not cover starting a workflow whose first step has no gate;
include both start cases in W2a acceptance. No deployment, credentials or
external publishing permission is implied by this backlog.

### W3: Project editor and execution UI (requires W1 and W2 contracts)

Owners: Project surfaces, `TeamWorkspacePage.tsx`, Task assignment UI, web API
types/hooks, run timeline and decisions. Use an ordered step list with add,
remove and reorder controls, not a graph canvas.

Acceptance:

- A Project owner saves/reloads a Team using only enabled Project Agents,
  assigns it to a Task, and sees step assignees, outputs and status.
- Editor preserves repeated assignees, names, order and explicit gate settings.
  Deployment creation starts with approval enabled.
- Run UI shows the frozen definition, current attempt, failure/missing output,
  approval wait, retry and cancellation; actions reflect actual permissions.
- Mutation invalidation and SSE/poll merging preserve newer event state;
  keyboard operation, validation and empty/error states work.

### Theme and device acceptance — owner requirement, 2026-11-16

The owner explicitly requires different themes and device sizes. These are W3
implementation and W4 release criteria, not completed validation. Reuse the
existing semantic theme tokens and light/dark/system preference behavior.

| Dimension | Required coverage |
| --- | --- |
| Theme | Light and dark at every size below; system preference resolves to both and follows a live OS preference change. |
| Phone | 320 × 568, 390 × 844, and landscape 844 × 390; touch controls and on-screen keyboard must leave actions reachable. |
| Tablet | 768 × 1024 and 1024 × 768; editor and timeline adapt to available content width. |
| Desktop | 1280 × 900 and 1920 × 1080; readable line lengths and usable dialogs. |

Exercise the ordered editor, Task Team selector, run timeline, approval,
failure/retry/cancel, and empty/loading/error states. Long Chinese/English names,
instructions and outputs must wrap without page-level horizontal overflow;
code/output panes may scroll locally. Reordering must work with touch and
keyboard controls, without requiring drag. At 200% zoom, controls and dialog
footers remain reachable. Status cannot rely on color alone; text, focus and
disabled states must remain legible in both themes.

Record browser assertions for overflow, control visibility, focus and actual
actions, plus reviewed screenshots for both themes at each size. Keep mocked UI
layout coverage distinct from real API/daemon end-to-end acceptance. Existing
generic theme or responsive tests do not prove these new workflow surfaces pass.

### W4: Integrated acceptance and release evidence (requires W1-W3)

Run focused backend store/API/authorization, sequential progression, event
replay/recovery and web tests first. Then run backend lint/type checks,
layering/module-size checks, full Python and TypeScript suites and production
build. Run migration/schema checks if schema changes. Exercise the complete
four-step flow, gated deployment, failed verification, retry, cancellation and
snapshot editing through the real UI. Report exact results and limitations.

Shipping requires W1-W4. Partial foundations must be labeled and safely reject
unsupported execution. Publishing, pushing, merging and production deployment
remain separate external actions requiring authorization.

### W2 manifest adapter checkpoint — 2026-11-16

`compile_assignment_work_graph` now has a workflow-specific branch that validates
its full assignment sequence against the frozen definition. It preserves the
compiler's stable work-item identity, per-attempt assignment identity, user order,
step contracts, objectives and acceptance criteria. Round manifests retain run/step/attempt
identity and approval requirements with a distinct `project-workflow-v1` policy.
Legacy manifests retain their previous format, including legacy approval handling.
The pure workflow compiler is registered with the existing policy-layer tests;
it cannot import application, persistence or API modules.

This is still a guarded foundation. No workflow daemon command, durable gate
event or owner decision endpoint is implemented here. W2 runtime acceptance and
W3/W4 remain open; the unavailable-execution guards remain mandatory.

Verification for this adapter: 361 focused compiler/API/store/legacy tests pass;
the elevated full backend suite passes 4498 tests (34 skipped). Ruff, mypy and
standalone TypeScript compilation pass. Standard production build and `npm test`
still stop at the Next.js CSS process/port EPERM, including elevated attempts.
This verification does not substitute for the still-unimplemented workflow
runtime acceptance cases.

### W2 durable gate ledger checkpoint — 2026-11-16

The Python session reducer now supports internal `workflow.started` and
`workflow.gate_decided` events. Start freezes the validated full assignment
sequence and scope in `workflowRuns`; the first step begins in
`awaiting_approval` or `ready`. Gate decisions bind the run, step, attempt,
assignment, owner audit identity and expected revision. Rejection sets
`blocked`; approval sets `ready` without creating an Agent Run or command.
The existing session-store transaction rolls back stale or invalid decisions,
including the attempted event append. Tests exercise two store instances racing
opposite decisions and reconstruct the projection from the accepted event log.

These are internal persistence primitives with **no production producer or
public approval endpoint**. An audit owner id is not HTTP authentication.
Registry admission, command staging, completion/output transport, subsequent
steps, owner-session authorization, retry/cancel and TypeScript materialization
remain required before emitting these events in production. Existing execution
guards remain unchanged. This checkpoint does not complete W2 or supersede
legacy approval/repair policies. Record the workflow ADR exception when the
execution adapter actually implements it.

### W2 registry safety review — 2026-11-16

Real registry tests exposed that direct compiled workflow assignments could
bypass the application-level unavailable guard and emit a first-step command.
The registry now rejects workflow-marked requests before preparation,
activation, successor delivery and staged-command recovery. A legacy approved
index does not authorize a workflow attempt. Recovered delivered executions
retain their reservations and can still receive a stop request.

This is a fail-closed safety repair, not the workflow execution adapter. Replace
the registry guard only when run/step/attempt-bound owner decisions, live
admission, output checks, sequential progression and recovery are implemented
together. The approved W2 runtime and W3/W4 remain outstanding.

### W2 authenticated gate API checkpoint — 2026-11-16

`POST /api/v1/threads/{sessionId}/workflow-decisions` now produces durable
`workflow.gate_decided` events for an existing workflow ledger. It requires the
owner's real user session, checks live Project ownership and Computer scope,
validates live roster/Placement admission for approval, and binds the decision
to the run, step, attempt, assignment and expected revision. Body fields cannot
overwrite audit metadata. Concurrent HTTP decisions record one accepted outcome;
duplicate and stale answers leave both the snapshot and log unchanged. Changes
to the Team definition do not reinterpret the frozen gate.

This is a partial checkpoint, not workflow execution. `workflow.started` still
has no production producer. Approval records `ready` but dispatches nothing.
All unavailable-execution guards remain. Required-output progression, attempt
retry/cancel, exit/reconciliation fences and client materialization are pending.
The legacy-policy ADR exception remains to be recorded with the execution
adapter; this API does not change legacy repair or missing-output policies.

Verification: 225 focused tests (including 37 new HTTP gate cases), 232 legacy
Team regressions, Ruff and mypy (480 files) pass. Production build again fails
at Next.js CSS local port EPERM in ordinary and escalated execution. W2 runtime
acceptance, W3 and W4 remain open.

### W2 production first-step staging checkpoint — 2026-11-16

`POST /teams/{teamId}/workflow-gates` now produces `workflow.started` through
`WorkflowGateStagingMixin.stage_workflow_gate`. The owner login session selects
an enabled Project workflow Team with a gated first step. The server resolves
the live roster/Placements and freezes the actual saved step order, including
repeated assignees, in a new Project-scoped Thread. Thread creation and start
append share one transaction. An owner/Team/request-UUID identity plus a durable
resource lock makes retries and concurrent requests return one original ledger.
Conflicting goals are refused. Start events record the server-authenticated actor.

This supersedes earlier statements that start had no production producer. It
completes **gate staging only**: no run request, command or reservation is created,
including by recovery; an owner decision changes only ledger readiness. Ungated
first steps still cannot start. Existing Team/Task/conversation/registry runtime
guards remain. W2 delivery, structured-output progression, retry/cancel recovery
fences and shared client materialization remain unimplemented; W3/W4 are pending.
Do not describe this checkpoint as runnable workflows or release acceptance.

Staging review also reproduced a legacy cancellation/deletion bypass with a
chat-service identity plus owner cookie. Workflow-ledger Threads now require
their owner's login for those operations. Legacy Threads keep their existing
policy; cancellation remains available to the owner after admission is invalid.
The cancelled ledger stays historical and staging replay cannot reopen it.

### W2a first-step admission checkpoint — 2026-11-16

The owner start API `/teams/{teamId}/workflow-runs` (with `/workflow-gates` as
an alias) now freezes a durable prepared request alongside the workflow ledger.
A pending gate creates no command/reservation. Ungated start or current owner
approval uses the dedicated first-attempt adapter and existing command queue.
The frozen request identity, assignment sequence, attempt and ledger revision
are checked along with live Project, roster, Placement and Computer admission.
Approval and command publication share a transaction. Replayed/concurrent owner
actions cannot duplicate the command, and publication failure rolls back approval.

This is **first-step admission only**. Generic workflow execution guards remain;
terminal results cannot enter legacy success/repair progression. No automatic
retry, successor delivery, unsupported staged-command recovery or reservation
release was enabled. W2b/W2c/W3/W4 remain outstanding, including UI themes and
device-size validation. See the thread handoff for exact verification and the
production-build environment failure; this checkpoint is not release acceptance.

## W2b runtime implementation — 2026-11-16

The dedicated Project workflow adapter now records terminal attempt results,
requires structured success and named recorded outputs, and admits successors
in frozen order. The same Agent can own multiple steps. Every successor receives
successful predecessor reports; a failed/missing report blocks the current step
without entering legacy repair policy. Current-attempt approval and publication
are atomic, including publication failures inside a surrounding report transaction.

Owner `retry`/`cancel` actions use the revision-bound workflow decision API.
Retry allocates a new attempt only after prior execution has settled; a gated
retry requires fresh approval. Owner reconciliation records an interruption and
leaves the workflow blocked for a separate retry. Cancellation preserves delivered
reservations until daemon exit or explicit reconciliation; late success cannot
start downstream work. Roster/Placement changes block admission. Capacity or
liveness waits remain prepared, without rerunning successful work.

The 12-file focused regression passes 210 tests, including 20 registry/API
progression tests (four steps, repeated Agent, definition edit, outputs, gates,
concurrent retries/approvals, publication rollback, restart, invalid Placement,
cancellation and reconciliation). Backend lint and type checks pass. The final full
backend suite passes 4,675 tests with 34 skipped (escalated for local socket/TTY
access); exact commands/results are recorded in the thread handoff.
`npm run build`, including an escalated retry, still fails in Next.js `app.css`
process creation/port binding with EPERM; no production build pass is claimed.

Generic Task assignment, conversation, Agent-run, legacy approval and unsupported
staged-command recovery remain guarded. W2c must materialize
`workflow.step_finished`, `workflow.admission_blocked`, `workflow.interrupted`,
and `workflow.recovery_decided`, plus workflow cancellation from `session.status`.
W3 UI/Task entry work and W4 theme/device acceptance remain separate and unverified.
