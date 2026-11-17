# Teams and Workflows

A Team defines the available Agents and their Computer. A Workflow defines
how they work together. Teams choose a default Workflow; Tasks and Automations
inherit it or explicitly choose another Workflow from the same selector.

Three immutable predefined Workflows preserve the existing execution policies:

| Workflow | Behavior |
| --- | --- |
| Build → Review | Roles choose a builder and reviewer; review findings can trigger repair. |
| Pipeline | Eligible Agents run in role order. |
| Lead-led | The lead plans, delegates dynamically, and reviews the result. |

Custom Workflows define explicit steps and Project scope. A Team can own
several, such as feature delivery and bug repair. A Custom Workflow may be the
Team default, but Tasks must belong to its Project. Selecting a predefined
Workflow explicitly can override that default. No incompatible selection falls
back to ordinary Team work.

Create a Team first. Its page lists every Workflow it can run — the three
predefined ones, then its custom ones — and marks the default. Create a custom
Workflow there with New workflow (choosing one of your Projects where the
Team's Agents are enabled), or from a Project's Agents tab by selecting the
Team. Assign each step to an enabled Agent in both rosters. The Team must
be on the Project's Computer. Saving a Custom Workflow never changes Team membership,
leadership, the default Workflow selection, or final-turn approval settings.

Start a Workflow from the Project, or select the Team and Workflow in a Project
Task or Automation. Each run records a frozen definition in a new Project
Thread. Editing or deleting a definition leaves existing runs intact. Approval,
retry, cancellation, and execution reservations retain their existing behavior.
The Team's live availability and the current step's membership are checked at
admission; removing a participant cannot authorize a later step.

## API

All routes require the owner's signed-in session; service actors cannot manage
or start definitions. Definition writes additionally require Project ownership.

- `GET /api/v1/teams/{teamId}/workflows`
- `POST /api/v1/teams/{teamId}/workflows`
- `PATCH /api/v1/teams/{teamId}/workflows/{workflowId}`
- `DELETE /api/v1/teams/{teamId}/workflows/{workflowId}`
- `POST /api/v1/teams/{teamId}/workflows/{workflowId}/runs`

Writes accept `name`, `projectId`, `workflowSteps`, and optional `enabled`.
A definition's Team and Project cannot change. Names are case-insensitively
unique within a Team. Run requests accept `requestId` and `taskGoal`; a retry
with the same request and goal returns that Workflow's original Thread.
Team writes accept `defaultWorkflowId`. Tasks carry `assignedTeamId` and optional
`assignedWorkflowId`; clearing the latter inherits the current Team default.
Predefined IDs are `preset:build_review`, `preset:pipeline`, and `preset:lead_led`.
Team responses expose `defaultWorkflowId` and the combined `workflowOptions`
catalog alongside the existing custom `workflows` collection.
A default definition cannot be disabled or deleted until another default is chosen. Changing Team clears the old Workflow
unless the request explicitly selects one belonging to the new Team.

## Persistence and compatibility

Workflows have independent IDs and are child entities in the Team aggregate.
Definition changes use the Team store's transactional version check and append
`team.workflow_created`, `team.workflow_updated`, or `team.workflow_deleted`.
They are stored in the existing JSON snapshot, so no schema migration or new
startup repair is required. The Team API includes its `workflows` collection.

Legacy workflow Teams are exposed as one Workflow with the existing Team ID.
Their old fields and routes remain compatible; frozen historical run records
are never rewritten. Once the collection is edited, it is authoritative for
definition management and dedicated starts. New editor saves use only the
nested Workflow API and never create another Team for another process.

Older backend versions do not understand a separate Workflow selection. After
creating Tasks with `assignedWorkflowId`, use a forward fix rather than rolling
back to such a version: it could dispatch ordinary Team collaboration instead
of the selected process. No schema rollback is needed, but dispatch semantics
must stay aware of the new assignment field.

## Unified entry and compatibility

`POST /agent-runs` and Thread messages accept `workflowId` for predefined
selections. A new owner-session Team conversation with a custom selection or
custom Team default opens that Workflow's Project Thread. An existing Team
thread cannot run a custom default, so its later rounds keep the predefined
Workflow its latest round ran. A scheduled Task that cannot run its selected
custom Workflow (no Project, or a missing one) is blocked once rather than
retried every tick; an offline Project Computer keeps it queued, recording that
wait only when it changes. The workflow run
endpoint also accepts predefined IDs. It uses the same request-key replay as
other predefined runs. Custom conversation starts reject attachment,
connection-grant, and assignment overrides rather than discarding them.

Legacy Team `collaborationStyle`, Task `collaborationStyle`, and run `style`
remain input/read compatibility aliases. Explicit canonical selections win over
stored aliases; contradictory explicit run fields are refused. Frozen existing
histories are not rewritten. Predefined snapshots include their Workflow ID
while retaining the execution fields that older clients display.

When the owner explicitly chooses a default on a legacy workflow Team, Relay
moves its existing steps into the child definition collection in the same Team
transaction. The Team can then select predefined defaults as well. The legacy
Workflow keeps its identity and saved steps, and old Run records are preserved.
The composer sends an explicit resolved Workflow ID for each opening turn, so
its retry remains pinned to the original choice after Team defaults change.
