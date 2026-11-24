"""The compact Task fields used by the Home panels."""

HOME_TASK_FIELDS = frozenset({
    "id", "number", "title", "priority", "status", "isRoutine", "ownerUserId", "assigneeUserId",
    "projectId", "computerId", "sourceRoutineId", "linkedSessionIds", "createdAt", "updatedAt",
    "startedAt", "finishedAt", "dueDate", "scheduledFor", "routineState", "routineNextRunAt",
    "assignedAgentId", "assignedTeamId", "assignedWorkflowId", "workspaceBinding", "workspaceWaiting", "dispatchClaim",
    "dispatchOutcome", "prerequisiteTaskIds", "waitingOn", "waitingOnSummaries", "blockerReason", "awaiting",
})

HOME_GROUP_LIMIT = 50
