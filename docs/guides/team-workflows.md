# Teams and Workflows

A Workflow belongs to the Team or Project where it was created. Create a Team
workflow from **Team → Workflows → New workflow**, without selecting a Project.
Run it directly with its owning Team in a Project. Standalone Tasks and Automations
assigned to an ordinary Team use a predefined process. Create a Project workflow
from **Project → Workflows**; it is available
to Tasks and Automations in that Project. Usage and Team links do not transfer
ownership. The backend enforces these scopes as well as the selectors.

Team workflows retain explicit step Agents from the Team. Select a Project for
execution (or use the Task/Automation's Project); its enabled roster and Computer
must support those steps. A Team definition remains reusable after each run.

## Project work

Create a Workflow in its Project, assign each step to an enabled Project Agent,
and add instructions, acceptance criteria, and optional approval gates. Every
step Agent needs an active Placement on the Project's Computer. A Project with
no Teams can create and run a Workflow. Start run asks for the goal and defaults
to independent execution; an eligible assigned Team can be selected optionally.

Project Tasks and Automations can select a Project-owned Workflow directly, with no Agent or Team assignment. Choosing an individual Agent clears the Workflow. Standalone Tasks and Automations can select an Agent or ordinary Team regardless of Project membership. An incompatible selection blocks saving/dispatch
instead of silently changing the process.

Teams list their assigned custom Workflows with Project links and step previews.
Assign workflow offers definitions on the same Computer whose step Agents are
all Team members. An assignment never remaps step Agents. Set as default applies
to that Project only; clear that default before unassigning, disabling, or deleting
the definition. A selected but invalid default requires explicit repair.

Three predefined Workflows retain their Team role policies:

| Workflow | Behavior |
| --- | --- |
| Build → Review | Roles choose a builder and reviewer; findings can trigger repair. |
| Pipeline | Eligible Agents run in role order. |
| Lead-led | The lead plans, delegates dynamically, and reviews the result. |

Predefined Workflows require a Team. Selection resolves an explicit Task choice,
then the Team's default for the Task's Project, then its predefined default, then
the system predefined default. Existing legacy custom defaults remain readable
until changed. A custom Workflow has one immutable Team or Project owner; cross-Project
templates and role-based step reassignment are outside this version.

## Execution

A run freezes its definition, explicit participants, Project, and optional Team
in a new Project Thread. Later definition edits do not alter its ledger. The
owner answers approval and questions, retries failures, or cancels from the
Thread. Project/Agent availability and Placement are checked on admission;
a run naming a Team also requires that Team's live availability and membership.
Removing access cannot be bypassed by a frozen snapshot. Tasks, scheduler starts,
and Automation occurrences use the same admission and execution path.

Daemons execute every step. Revision-bound decisions, deterministic request
replay, retries, cancellation, Task generations, and exit/reconciliation
reservations retain the existing runtime behavior. Standalone runs create no
synthetic Team and need no lead. New ledgers expose `workflowSnapshot`; the
historical `teamSnapshot` field remains a wire alias for older clients.

Task Activities shows the current Workflow Run first, or the latest one when
none is current. Its summary shows the current step, Agent, status, and step
count. Expand each Run to review its steps or open its Thread. The Thread owner
can approve a waiting step from Task Activities when that Run is current.

In the Thread, select **View run details** to review all steps, attempts,
and output in one scrollable view. Press Escape to close it and return focus to
the button.

## API

All paths below are under `/api/v1`. These routes require the owner's signed-in
session; service actors cannot manage or start definitions.

| Method and path | Purpose |
| --- | --- |
| `GET /workflows?projectId={id}` | List the owner's definitions, optionally by Project. |
| `POST /workflows` | Create a Project definition. |
| `GET /workflows/{id}` | Read the owned definition. |
| `PATCH /workflows/{id}` | Edit the definition. |
| `DELETE /workflows/{id}` | Soft-delete after repairing referencing defaults. |
| `POST /workflows/{id}/runs` | Start independently or with optional `teamId`. |
| `PUT /teams/{teamId}/workflows/{id}/link` | Assign the definition to an eligible Team. |
| `DELETE /teams/{teamId}/workflows/{id}/link` | Unassign without deleting the definition. |
| `PUT /teams/{teamId}/workflow-defaults/{projectId}` | Set the Project default with `{workflowId}`. |
| `DELETE /teams/{teamId}/workflow-defaults/{projectId}` | Clear that Project's custom default. |

Definition writes accept `name`, `workflowSteps`, optional `enabled`, and exactly
one of `projectId` or `ownerTeamId`. Team creation routes supply the Team owner. Names are case-insensitively unique for new definitions/renames in a
Project; migration preserves existing duplicates. Owner scope cannot change.
Run requests accept a UUID `requestId`, `taskGoal`, optional `teamId`, and a
`projectId` for Team-owned definitions. Team-owned runs require their owning Team.
Retrying the same request returns its original Thread; changing goal or Team
with that request conflicts. Project Task/Automation records use `assignedWorkflowId`
without `assignedTeamId`; an individual `assignedAgentId` conflicts.
Predefined IDs remain `preset:build_review`, `preset:pipeline`, `preset:lead_led`.

The old `/teams/{teamId}/workflows` CRUD/run routes and legacy Team definition
fields remain adapters to the same canonical definitions. Team responses retain
`workflows` and `workflowOptions` as projections of assigned definitions and
`projectWorkflowDefaults` as a Project-to-Workflow map. Existing global
`defaultWorkflowId` and `collaborationStyle` remain compatibility inputs.

## Migration and operations

Run `make backend-migrate` before serving the new version. Migration 0130 adds
Team ownership and requires exactly one Team/Project owner; existing definitions
retain their Project ownership. Migration 0129
extracts old nested/legacy definitions into `workflows`, with versioned
`workflow_events` and `team_workflow_links`. It preserves IDs, Project scope,
steps, enabled states, timestamps, and existing defaults. Team snapshots retain
compatibility markers, but their nested collection is no longer a second
writable source of definition data. Historical/active run snapshots are untouched.
Database-only test/direct-store construction performs the same idempotent import.

Once definitions exist, the migration refuses downgrade: Project-only definitions cannot
be represented losslessly in the old Team aggregate. Use a forward fix after
rollout. Restore a pre-upgrade backup only as an explicit recovery operation;
older code cannot safely dispatch standalone Workflow Task assignments.

## Unified entry and compatibility

`POST /agent-runs` and Thread messages accept `workflowId` for predefined
selections. A new owner-session Team conversation with a custom selection or
applicable custom default opens that Workflow's Project Thread. Existing Team
Threads keep their last predefined round policy when a later custom default
cannot run in that Thread. The legacy Team run endpoint accepts predefined IDs
and preserves request replay. Custom conversation starts reject attachment,
connection-grant, and assignment overrides instead of discarding them.

Scheduled Tasks with an unavailable custom selection or missing Project block
once. An offline Project Computer keeps the Task queued and records the wait
only when it changes. Existing execution reservation and recovery rules apply.

Legacy Team/Task `collaborationStyle` and run `style` remain input/read aliases;
explicit canonical selections win over stored aliases, and contradictory
explicit run fields are refused. Choosing a predefined default on a legacy
Workflow Team preserves its independent custom definition and historical Runs.
The composer resolves its opening selection explicitly so retries stay pinned
even when defaults change.

See [ADR-025](../adr/025-independent-project-workflows.md) for the ownership
tradeoff and [verification](team-workflows-verification.md) for test evidence.
