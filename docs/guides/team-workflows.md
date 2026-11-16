# Teams and Workflows

A Team defines the available Agents and their Computer. A Workflow defines an
ordered process using that roster. A Team can own several named Workflows,
for example feature delivery and bug repair. Without a selected Workflow,
the Team continues to use its collaboration style.

Create a Team first. In a Project's Agents tab, create a Workflow, select that
Team, and assign each step to an enabled Agent in both rosters. The Team must
be on the Project's Computer. Saving a Workflow never changes Team membership,
leadership, collaboration style, or final-turn approval settings.

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
Tasks carry `assignedTeamId` and optional `assignedWorkflowId`; clearing the
latter returns to Team collaboration. Changing Team clears the old Workflow
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
