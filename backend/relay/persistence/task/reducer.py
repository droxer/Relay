"""The task event reducer: replaying events into a task snapshot."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ...automations.model import LEGACY_FIELDS, STATES, upgrade_legacy
from ...tasks.flow import apply_flow_status
from .numbering import NUMBERED_EVENT, apply_task_number


def materialize_task_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    created = next(
        (event for event in events if event.get("type") == "task.created"), None
    )
    if not created:
        raise ValueError("Relay task event log is missing task.created.")
    task: dict[str, Any] = {
        "id": created["taskId"],
        "title": created["title"],
        "description": created.get("description", ""),
        "priority": created.get("priority", "normal"),
        "status": "backlog",
        "workflowStage": "backlog",
        "acceptancePolicy": created.get("acceptancePolicy", "automatic"),
        "isRoutine": bool(created.get("isRoutine")),
        "linkedSessionIds": [],
        "occurrenceIds": [],
        "activity": [],
        "createdAt": created["timestamp"],
        "updatedAt": created["timestamp"],
        "events": [],
    }
    if "routineEnabled" in created:
        # Only a legacy record says this; v2 routines carry routineState.
        task["routineEnabled"] = bool(created["routineEnabled"])
    if created.get("ownerUserId"):
        task["ownerUserId"] = created["ownerUserId"]
    if created.get("assigneeUserId"):
        task["assigneeUserId"] = created["assigneeUserId"]
    if created.get("projectId"):
        task["projectId"] = created["projectId"]
    if created.get("dueDate"):
        task["dueDate"] = created["dueDate"]
    if created.get("sourceRoutineId"):
        task["sourceRoutineId"] = created["sourceRoutineId"]
    if created.get("scheduledFor"):
        task["scheduledFor"] = created["scheduledFor"]
    if created.get("routineTriggerKind"):
        task["routineTriggerKind"] = created["routineTriggerKind"]
    if created.get("routineTriggerSummary"):
        task["routineTriggerSummary"] = created["routineTriggerSummary"]
    if "routineTriggerDepth" in created:
        task["routineTriggerDepth"] = int(created["routineTriggerDepth"] or 0)
    if created.get("collaborationStyle"):
        task["collaborationStyle"] = created["collaborationStyle"]
    if created.get("tags"):
        task["tags"] = list(created["tags"])
    _apply_task_routine_fields(task, created)
    apply_task_number(task, created)
    for event in events:
        task["events"].append(event)
        task["updatedAt"] = event["timestamp"]
        handler = TASK_EVENT_HANDLERS.get(event.get("type", ""))
        if handler:
            handler(task, event)
    return task


def _apply_task_workspace_wait(task: dict[str, Any], event: dict[str, Any]) -> None:
    if event.get("waiting"):
        task["workspaceWaiting"] = dict(event["waiting"])
    elif (task.get("workspaceWaiting") or {}).get("runId") == event.get("runId"):
        task.pop("workspaceWaiting", None)


def _apply_task_workspace_bound(task: dict[str, Any], event: dict[str, Any]) -> None:
    binding = event["binding"]
    current = task.get("workspaceBinding")
    if current and current != binding:
        raise ValueError(
            "workspace_unavailable: a task's workspace binding is immutable."
        )
    task["workspaceBinding"] = dict(binding)


def _apply_task_updated(task: dict[str, Any], event: dict[str, Any]) -> None:
    for key in (
        "title",
        "description",
        "priority",
        "assigneeUserId",
        "dueDate",
        "acceptancePolicy",
        "collaborationStyle",
    ):
        if key not in event or event[key] is None:
            continue
        if key in ("assigneeUserId", "dueDate", "collaborationStyle") and event[key] == "":
            task.pop(key, None)
        else:
            task[key] = event[key]
    if isinstance(event.get("tags"), list):
        if event["tags"]:
            task["tags"] = list(event["tags"])
        else:
            task.pop("tags", None)
    _apply_task_routine_fields(task, event)


def _apply_task_project_set(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["projectId"] = event["projectId"]
    apply_task_number(task, event)


def _apply_task_assigned(task: dict[str, Any], event: dict[str, Any]) -> None:
    if event.get("teamId"):
        task["assignedTeamId"] = event["teamId"]
        task.pop("assignedAgent", None)
        task.pop("assignedAgentId", None)
        return
    task["assignedAgent"] = event["agent"]
    if event.get("agentId"):
        task["assignedAgentId"] = event["agentId"]
    else:
        task.pop("assignedAgentId", None)
    task.pop("assignedTeamId", None)


def _apply_task_unassigned(task: dict[str, Any], _event: dict[str, Any]) -> None:
    task.pop("assignedAgent", None)
    task.pop("assignedAgentId", None)
    task.pop("assignedTeamId", None)


def _apply_task_dispatch_claimed(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["dispatchClaim"] = event["claim"]


def _apply_task_dispatch_released(task: dict[str, Any], event: dict[str, Any]) -> None:
    if task.get("dispatchClaim", {}).get("id") == event.get("claimId"):
        task.pop("dispatchClaim", None)


def _apply_task_dispatch_outcome(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["dispatchOutcome"] = event["outcome"]


def _apply_task_dispatch_retry(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["dispatchRetry"] = event["retry"]


def _apply_task_dispatch_retry_cleared(
    task: dict[str, Any], _event: dict[str, Any]
) -> None:
    task.pop("dispatchRetry", None)


def _apply_task_occurrence_created(task: dict[str, Any], event: dict[str, Any]) -> None:
    occurrence_id = event["occurrenceId"]
    if occurrence_id not in task["occurrenceIds"]:
        task["occurrenceIds"] = [*task["occurrenceIds"], occurrence_id]


def _apply_task_round(task: dict[str, Any], event: dict[str, Any]) -> None:
    """Apply a round's verdict and what a continuation of it would need.

    Kept out of task.updated because these are execution facts, not user edits:
    a person editing the title must never disturb the round bookkeeping, and a
    round completing must never look like someone edited the task.
    """
    if event.get("executionOwner") is not None:
        task["lastRoundExecutionOwner"] = event["executionOwner"]
    if event.get("roundResult") is not None:
        task["lastRoundResult"] = event["roundResult"]
    if event.get("roundCount") is not None:
        task["roundCount"] = event["roundCount"]
    if event.get("continuationSessionId") is not None:
        task["continuationSessionId"] = event["continuationSessionId"]
    if event.get("clearContinuation"):
        task.pop("continuationSessionId", None)


def _apply_task_status(task: dict[str, Any], event: dict[str, Any]) -> None:

    apply_flow_status(task, event)
    task["status"] = event["status"]
    if event["status"] != "running":
        task.pop("workspaceWaiting", None)


def _apply_task_deleted(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["deletedAt"] = event["timestamp"]
    if event.get("actorUserId"):
        task["deletedByUserId"] = event["actorUserId"]


def _apply_task_session_linked(task: dict[str, Any], event: dict[str, Any]) -> None:
    if event["sessionId"] not in task["linkedSessionIds"]:
        task["linkedSessionIds"] = [*task["linkedSessionIds"], event["sessionId"]]


def _apply_task_session_unlinked(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["linkedSessionIds"] = [
        session_id
        for session_id in task["linkedSessionIds"]
        if session_id != event["sessionId"]
    ]


def _apply_task_activity(task: dict[str, Any], event: dict[str, Any]) -> None:
    task["activity"] = [*task["activity"], event["activity"]]


TaskEventHandler = Callable[[dict[str, Any], dict[str, Any]], None]


def _apply_task_execution_claimed(task: dict[str, Any], event: dict[str, Any]) -> None:
    task.setdefault("startedAt", event["timestamp"])
    _apply_task_status(task, {**event, "status": "assigned"})
    task["executionOwner"] = {
        "requestId": event["requestId"], "revision": event["revision"],
    }


TASK_EVENT_HANDLERS: dict[str, TaskEventHandler] = {
    "task.execution.claimed": _apply_task_execution_claimed,
    "task.workspace_bound": _apply_task_workspace_bound,
    "task.workspace_wait": _apply_task_workspace_wait,
    "task.updated": _apply_task_updated,
    "task.project_set": _apply_task_project_set,
    NUMBERED_EVENT: apply_task_number,
    "task.assigned": _apply_task_assigned,
    "task.unassigned": _apply_task_unassigned,
    "task.dispatch_claimed": _apply_task_dispatch_claimed,
    "task.dispatch_released": _apply_task_dispatch_released,
    "task.dispatch_outcome": _apply_task_dispatch_outcome,
    "task.dispatch_retry": _apply_task_dispatch_retry,
    "task.dispatch_retry_cleared": _apply_task_dispatch_retry_cleared,
    "task.occurrence_created": _apply_task_occurrence_created,
    "task.round": _apply_task_round,
    "task.status": _apply_task_status,
    "task.deleted": _apply_task_deleted,
    "task.session_linked": _apply_task_session_linked,
    "task.session_unlinked": _apply_task_session_unlinked,
    "task.activity": _apply_task_activity,
}


V2_ROUTINE_FIELDS = ("routineTriggers", "routineState", "routinePauseReason", "routineNextRunAt")


def _apply_task_routine_fields(task: dict[str, Any], event: dict[str, Any]) -> None:

    if "isRoutine" in event and event["isRoutine"] is not None:
        task["isRoutine"] = bool(event["isRoutine"])
        if not task["isRoutine"]:
            for key in (*V2_ROUTINE_FIELDS, *LEGACY_FIELDS):
                task.pop(key, None)
            return
    if not task.get("isRoutine"):
        return
    if any(key in event for key in V2_ROUTINE_FIELDS):
        _apply_v2_routine_fields(task, event)
    elif any(event.get(key) is not None for key in LEGACY_FIELDS):
        _apply_legacy_routine_fields(task, event)


def _apply_v2_routine_fields(task: dict[str, Any], event: dict[str, Any]) -> None:

    # A v2 write is a decision made with the upgraded fields in view; the
    # retained legacy seed no longer applies.
    for key in LEGACY_FIELDS:
        task.pop(key, None)
    if isinstance(event.get("routineTriggers"), list):
        task["routineTriggers"] = [dict(trigger) for trigger in event["routineTriggers"]]
    if event.get("routineState") in STATES:
        task["routineState"] = event["routineState"]
        if event["routineState"] != "paused_by_relay":
            task.pop("routinePauseReason", None)
    for key in ("routinePauseReason", "routineNextRunAt"):
        if key in event:
            if event[key]:
                task[key] = event[key]
            else:
                task.pop(key, None)


def _apply_legacy_routine_fields(task: dict[str, Any], event: dict[str, Any]) -> None:
    """An old event: mirror it onto the legacy keys, then re-derive v2 from them.

    The mirrored keys are the accumulator, so a snapshot stored before v2 existed
    upgrades correctly when its next legacy event arrives.
    """

    if "routineTriggers" in task and not any(key in task for key in LEGACY_FIELDS):
        _apply_legacy_state_to_v2(task, event)
        return
    _mirror_legacy_routine_fields(task, event)
    upgraded = upgrade_legacy({key: task[key] for key in LEGACY_FIELDS if key in task})
    task["routineTriggers"] = upgraded["routineTriggers"]
    task["routineState"] = upgraded["routineState"]
    if "routinePauseReason" in upgraded:
        task["routinePauseReason"] = upgraded["routinePauseReason"]
    else:
        task.pop("routinePauseReason", None)


def _apply_legacy_state_to_v2(task: dict[str, Any], event: dict[str, Any]) -> None:
    """A legacy-shaped write on a v2 snapshot (a v1 API PATCH, an old writer).

    The triggers were decided in v2, so the event's legacy timing —
    cadence, next run date, trigger, type — must not re-derive them, and no
    legacy key comes back. Only ``routineEnabled`` carries over, as state.
    """
    enabled = event.get("routineEnabled")
    if enabled is True:
        task["routineState"] = "active"
        task.pop("routinePauseReason", None)
    elif enabled is False:
        if event.get("routineDisabledReason") == "rate_limited":
            task["routineState"] = "paused_by_relay"
            task["routinePauseReason"] = "rate_limited"
        else:
            task["routineState"] = "paused"
            task.pop("routinePauseReason", None)


def _mirror_legacy_routine_fields(task: dict[str, Any], event: dict[str, Any]) -> None:
    # Compatibility mirror for legacy readers; removed in the v2 API task.
    if "routineEnabled" in event and event["routineEnabled"] is not None:
        task["routineEnabled"] = bool(event["routineEnabled"])
    if event.get("routineEnabled") is True:
        task.pop("routineDisabledReason", None)
    if "routineDisabledReason" in event and event["routineDisabledReason"] is not None:
        if event["routineDisabledReason"]:
            task["routineDisabledReason"] = event["routineDisabledReason"]
        else:
            task.pop("routineDisabledReason", None)
    if isinstance(event.get("routineTrigger"), dict):
        task["routineTrigger"] = dict(event["routineTrigger"])
    if "routineType" in event and event["routineType"] is not None:
        task["routineType"] = event["routineType"]
    if "routineCadence" in event and event["routineCadence"] is not None:
        task["routineCadence"] = event["routineCadence"]
    if "routineNextRunDate" in event and event["routineNextRunDate"] is not None:
        if event["routineNextRunDate"]:
            task["routineNextRunDate"] = event["routineNextRunDate"]
        else:
            task.pop("routineNextRunDate", None)
