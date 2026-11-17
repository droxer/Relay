# Independent Workflows and optional Teams

## Status

Implemented on 2026-11-17. The current contract is in
[Teams and Workflows](../guides/team-workflows.md), with the durable decision in
[ADR-025](../adr/025-independent-project-workflows.md). This document retains
the design rationale; role-slot remapping and cross-Project templates remain
future capabilities.

## Product model

- A Team defines a stable group of Agents, its lead, roles, and Computer.
- A Workflow defines a process: steps, instructions, acceptance criteria, and
  approval gates. It has its own identity and lifecycle.
- A Project supplies the work context: workspace, enabled Agents, access, and
  Computer. A custom Workflow retains one Project scope in the first version.
- A Workflow Run executes a frozen definition with resolved participants in a
  Project Thread. Its Team is optional.

A Project owner manages its custom Workflows. A Team can reference several
eligible Workflows; referencing one never transfers ownership or creates a copy.
The same Project-scoped definition can be available to multiple Teams that meet
its participant constraints. A Workflow also remains runnable directly from
its Project when no Team references it.

The first version keeps custom steps assigned to explicit Agents. Assigning a
Workflow to another Team requires those Agents to be in that Team; it never
silently remaps steps. Role-slot mappings and reusable cross-Project templates
are separate future capabilities.

## Two execution paths

| Selection | Participant rule | Runtime context |
| --- | --- | --- |
| Project + custom Workflow | Each step Agent is enabled in the Project and placed on its Computer | Project workspace and Thread; no Team required |
| Project + Team + custom Workflow | Each step Agent also belongs to the selected Team | Same Project execution path with Team context recorded |
| Team + predefined Workflow | Existing Team role compilation and policies | Existing supported Thread/Project context |

An independent custom Workflow does not need a synthetic Team or an invented
lead. Steps supply the execution order; the existing owner answers approval,
questions, retry, and cancellation decisions.

Predefined Build → Review, Pipeline, and Lead-led continue to require a Team in
this version. Supporting their role compilation directly from a Project roster
would be a separate behavior change.

## Applying Workflows to Project work

Projects get a Workflows view where the owner creates, edits, previews, and runs
custom definitions. Each definition can be used independently or made available
to an eligible Team. Team details show linked Workflows, their Project scope,
and a link to the definition's Project.

Task and Automation forms expose these choices:

1. Select the Project.
2. Select either an individual Agent, a Team, or a Workflow for the work.
3. When a Workflow is selected, choose an optional eligible Team. With no Team,
   its steps use the Project's enabled Agents directly.
4. When a Team is selected first, inherit its applicable default or select an
   available Workflow.

An explicit Workflow remains explicit: changing or removing the Team does not
discard it when the definition is still valid independently in the Project.
An incompatible choice stays visible with an explanation and blocks dispatch.

Custom default selection belongs to the Team's Project context, so making a
Workflow the default in Project A does not unexpectedly change Team work in
Project B. Resolution for Team work is: explicit work selection, Team default
for this Project, Team predefined default, system predefined default. A selected
but invalid default produces an actionable error, rather than silent fallback.
Standalone Project work explicitly selects its custom Workflow in this version;
there is no implicit Project-wide process change.

## Lifecycle and execution guarantees

- A Workflow is stored independently from the Team aggregate. Team links and
  defaults reference its stable ID.
- Unlinking or deleting a Team leaves the Workflow available in its Project.
- New standalone runs do not consult a previously linked Team. Runs explicitly
  using a Team continue to require that Team and its live participant membership.
- Removing a Project Agent blocks new admissions for affected steps. A saved
  definition or frozen participant snapshot cannot grant access by itself.
- Deleting a Workflow prevents new selection and keeps existing run snapshots
  and historical links readable. Referencing defaults require explicit repair.
- Every run freezes the definition, resolved Agents, optional Team, and Project
  context. Definition edits do not rewrite active or historical Runs.
- Task scheduling, Automations, and direct starts share admission and execution.
  Daemons continue to execute Agents; the backend only dispatches.

## Implementation boundary and migration

1. Add independent Workflow persistence and canonical definition/run APIs.
   Owner and Project authorization remain mandatory; Team authorization is
   additional when a run names one.
2. Extract existing nested definitions with their IDs, Project scopes, steps,
   enabled states, and timestamps preserved. Materialize Team references and
   Project-scoped defaults. Keep legacy definition routes as adapters to the
   same records; avoid two writable sources of truth.
3. Compile custom runs from a Workflow, Project, and optional Team. Remove the
   need to disguise a Workflow as a Team snapshot. Preserve existing frozen
   ledgers, request-key replay, approval binding, execution generations, and
   exit/reconciliation reservations.
4. Permit a Task/Automation to carry a Workflow selection without a Team.
   Update assignment validation, scheduler dispatch, and direct run entry
   together before exposing the standalone UI.
5. Introduce Project definition management and Team reference controls. Update
   `CONTEXT.md` and current guides with the implementation, retaining the
   distinction between a reusable Workflow and a Workflow Run.

ADR-021 remains authoritative for predefined role-based compilation and frozen
Team policies. This proposal keeps those execution policies; it changes the
custom Workflow ownership/selection contract currently documented in the Team
Workflows guide. It does not extend predefined policies to standalone Project
work.

Acceptance scenarios include creating and running a Workflow with zero Teams,
linking/unlinking multiple eligible Teams without copying definitions, selecting
the Workflow on a scheduled Task and Automation without a Team, retaining
standalone use after Team deletion, and refusing removed Project or Team
participants at admission. Migration tests must preserve old Workflow IDs,
Project scope, defaults, and active/historical execution snapshots.
