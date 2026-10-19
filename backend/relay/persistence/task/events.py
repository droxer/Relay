"""The event lists a task change appends: creation, updates, assignment,
project moves, rounds, dispatch outcomes, and routine occurrences.
"""

from __future__ import annotations

from typing import Any
from ...automations.model import is_active
from ...core.human_waits import ensure_wait_record
from ...core.ids import new_relay_id
from ...tasks.issue_triage import project_move_error
from ...core.models import AgentName
from ...core.ids import new_database_id, now_iso
from ..events import relay_task_event


def _task_session_link_events(task_id: str, session_id: str) -> list[dict[str, Any]]:
    return [
        relay_task_event("task.session_linked", task_id, {"sessionId": session_id}),
        relay_task_event(
            "task.activity",
            task_id,
            {
                "activity": {
                    "id": new_relay_id("act"),
                    "createdAt": now_iso(),
                    "message": f"Linked session {session_id}.",
                    "sessionId": session_id,
                }
            },
        ),
    ]


def _task_session_unlink_events(task_id: str, session_id: str) -> list[dict[str, Any]]:
    return [
        relay_task_event("task.session_unlinked", task_id, {"sessionId": session_id}),
        relay_task_event(
            "task.activity",
            task_id,
            {
                "activity": {
                    "id": new_relay_id("act"),
                    "createdAt": now_iso(),
                    "message": f"Unlinked deleted session {session_id}.",
                    "sessionId": session_id,
                }
            },
        ),
    ]


def task_creation_events(task_id: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    created_payload = {
        "title": payload["title"],
        "description": payload.get("description", ""),
        "priority": payload.get("priority", "normal"),
        "acceptancePolicy": payload.get("acceptancePolicy", "human"),
    }
    if payload.get("tags"):
        created_payload["tags"] = list(payload["tags"])
    for field in (
        "ownerUserId",
        "assigneeUserId",
        "projectId",
        "dueDate",
        "routineType",
        "routineCadence",
        "routineNextRunDate",
        "sourceRoutineId",
        "scheduledFor",
        "collaborationStyle",
        "routineTrigger",
        "routineTriggerKind",
        "routineTriggerSummary",
    ):
        if payload.get(field):
            created_payload[field] = payload[field]
    for field in ("routineTriggers", "routineState", "routinePauseReason", "routineNextRunAt"):
        if field in payload:
            created_payload[field] = payload[field]
    for field in ("isRoutine", "routineEnabled", "routineTriggerDepth"):
        if field in payload:
            created_payload[field] = payload[field]

    events = [relay_task_event("task.created", task_id, created_payload)]
    if payload.get("assignedAgent") or payload.get("assignedTeamId"):
        assignment = {}
        for field, event_field in (
            ("assignedAgent", "agent"),
            ("assignedAgentId", "agentId"),
            ("assignedTeamId", "teamId"),
        ):
            if payload.get(field):
                assignment[event_field] = payload[field]
        events.extend(task_assignment_events(task_id, assignment))
    if payload.get("status") and payload["status"] != "backlog":
        events.append(
            relay_task_event("task.status", task_id, {"status": payload["status"]})
        )
    return events


def task_assignment_events(
    task_id: str, assignment: dict[str, Any]
) -> list[dict[str, Any]]:
    if assignment.get("teamId"):
        assigned = relay_task_event(
            "task.assigned", task_id, {"teamId": assignment["teamId"]}
        )
        message = f"Assigned to team {assignment['teamId']}."
        activity_payload: dict[str, Any] = {}
    elif assignment.get("agent"):
        assigned_payload = {"agent": assignment["agent"]}
        if assignment.get("agentId"):
            assigned_payload["agentId"] = assignment["agentId"]
        assigned = relay_task_event(
            "task.assigned",
            task_id,
            assigned_payload,
        )
        message = (
            f"Assigned to logical agent {assignment['agentId']}."
            if assignment.get("agentId")
            else f"Assigned to {assignment['agent']}."
        )
        activity_payload = {"agent": assignment["agent"]}
    else:
        assigned = relay_task_event("task.unassigned", task_id, {})
        message = "Agent assignment cleared."
        activity_payload = {}
    return [
        assigned,
        relay_task_event(
            "task.activity",
            task_id,
            {
                "activity": {
                    "id": new_relay_id("act"),
                    "createdAt": now_iso(),
                    "message": message,
                    **activity_payload,
                }
            },
        ),
    ]


def validate_project_move_events(task: dict[str, Any], events: list[dict[str, Any]]) -> None:
    """Recheck triage against current state while holding the store write lock."""
    if any(event.get("type") == "task.project_set" for event in events):
        if code := project_move_error(task):
            raise ValueError(code)


def task_update_events(
    task_id: str,
    payload: dict[str, Any],
    *,
    assignment: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    updated = {
        field: payload.get(field)
        for field in (
            "title",
            "description",
            "priority",
            "assigneeUserId",
            "dueDate",
            "isRoutine",
            "routineType",
            "routineCadence",
            "routineNextRunDate",
            "routineEnabled",
            "acceptancePolicy",
            "collaborationStyle",
            "routineTrigger",
            "routineDisabledReason",
        )
    }
    # v2 keys are sent only when supplied: their presence marks a v2 event.
    # Tags likewise: an empty list clears them, so absence must stay distinct.
    for field in (
        "tags",
        "routineTriggers",
        "routineState",
        "routinePauseReason",
        "routineNextRunAt",
        "expectedStatus",
        "expectedExecutionRevision",
    ):
        if field in payload:
            updated[field] = payload[field]
    events = [relay_task_event("task.updated", task_id, updated)]
    if payload.get("projectId"):
        # Triage: an intake issue joins a project. It precedes the assignment
        # and status events so a replay validates them against the project.
        events.append(
            relay_task_event("task.project_set", task_id, {"projectId": payload["projectId"]})
        )
    assignment_supplied = "assignedAgentId" in payload or "assignedTeamId" in payload
    resolved_assignment = assignment
    if resolved_assignment is None and assignment_supplied:
        agent_id = payload.get("assignedAgentId")
        team_id = payload.get("assignedTeamId")
        if agent_id and team_id:
            raise ValueError("task_agent_and_team_conflict")
        if team_id:
            resolved_assignment = {"teamId": team_id}
        elif agent_id:
            agent = payload.get("assignedAgent")
            if not agent:
                raise ValueError("assignedAgent is required with assignedAgentId")
            resolved_assignment = {"agent": agent, "agentId": agent_id}
        else:
            resolved_assignment = {}
    if resolved_assignment is not None:
        events.extend(task_assignment_events(task_id, resolved_assignment))
    if payload.get("status"):
        status_payload = {"status": payload["status"]}
        # `statusReason` says why for any status (a parked wait quotes it);
        # `blockerReason` is the operator's own words for a block.
        reason = payload.get("blockerReason") or payload.get("statusReason")
        if reason:
            status_payload["reason"] = reason
        if payload["status"] == "waiting_for_human":
            if payload.get("statusSessionId"):
                status_payload["sessionId"] = payload["statusSessionId"]
            # Every wait has an id an answer must name (core/human_waits.py).
            status_payload["request"] = ensure_wait_record(payload.get("statusRequest"))
        if payload["status"] == "blocked":
            status_payload["attention"] = payload.get("attention") or {
                "code": "manual_block" if payload.get("actorUserId") else "unknown",
                "source": "operator" if payload.get("actorUserId") else "legacy",
            }
        if payload.get("actorUserId"):
            status_payload["actorUserId"] = payload["actorUserId"]
        events.append(relay_task_event("task.status", task_id, status_payload))
    return events


def routine_occurrence_events(
    routine: dict[str, Any],
    agent: AgentName | None,
    *,
    scheduled_for: str,
    trigger: dict[str, Any] | None = None,
    fired_by: str = "schedule",
) -> list[dict[str, Any]]:
    occurrence_date = scheduled_for
    occurrence_id = new_database_id()
    description = routine.get("description", "")
    if trigger and trigger.get("context"):
        description = (
            f"{description}\n\n{trigger['context']}"
            if description
            else trigger["context"]
        )
    events = [
        relay_task_event(
            "task.created",
            occurrence_id,
            {
                "title": routine["title"],
                "description": description,
                "priority": routine.get("priority", "normal"),
                **({"tags": list(routine["tags"])} if routine.get("tags") else {}),
                "acceptancePolicy": routine.get("acceptancePolicy", "automatic"),
                "dueDate": occurrence_date,
                "sourceRoutineId": routine["id"],
                "scheduledFor": occurrence_date,
                **(
                    {
                        "routineTriggerKind": trigger["kind"],
                        "routineTriggerDepth": trigger["depth"],
                        **({"routineTriggerSummary": trigger["summary"]} if trigger.get("summary") else {}),
                    }
                    if trigger
                    else {"routineTriggerKind": fired_by, "routineTriggerDepth": 0}
                ),
                **(
                    {"collaborationStyle": routine["collaborationStyle"]}
                    if routine.get("collaborationStyle")
                    else {}
                ),
                **(
                    {"ownerUserId": routine["ownerUserId"]}
                    if routine.get("ownerUserId")
                    else {}
                ),
                **(
                    {"assigneeUserId": routine["assigneeUserId"]}
                    if routine.get("assigneeUserId")
                    else {}
                ),
                **(
                    {"projectId": routine["projectId"]}
                    if routine.get("projectId")
                    else {}
                ),
            },
        )
    ]
    if agent or routine.get("assignedTeamId"):
        events.append(
            relay_task_event(
                "task.assigned",
                occurrence_id,
                {
                    **({"agent": agent} if agent else {}),
                    **(
                        {"agentId": routine["assignedAgentId"]}
                        if routine.get("assignedAgentId")
                        else {}
                    ),
                    **(
                        {"teamId": routine["assignedTeamId"]}
                        if routine.get("assignedTeamId")
                        else {}
                    ),
                },
            )
        )
    events.append(
        relay_task_event("task.status", occurrence_id, {"status": "assigned"})
    )
    return events


def triggered_occurrence_routine_events(
    routine_id: str, occurrence_id: str, scheduled_for: str, kind: str
) -> list[dict[str, Any]]:
    return [
        relay_task_event(
            "task.occurrence_created",
            routine_id,
            {
                "occurrenceId": occurrence_id,
                "scheduledFor": scheduled_for,
                "triggerKind": kind,
            },
        ),
        relay_task_event(
            "task.activity",
            routine_id,
            {
                "activity": {
                    "id": new_relay_id("act"),
                    "createdAt": now_iso(),
                    "message": f"Automation fired by {kind}: {occurrence_id}.",
                }
            },
        ),
    ]


def triggered_occurrence_allowed(
    routine: dict[str, Any], *, allow_paused: bool = False
) -> bool:
    """An active routine with a target may fire; ``allow_paused`` lets Run
    now fire a paused one too."""
    runnable = is_active(routine) or (
        allow_paused and routine.get("isRoutine") and not routine.get("deletedAt")
    )
    return bool(
        runnable
        and (
            routine.get("assignedAgent")
            or routine.get("assignedTeamId")
            or routine.get("projectId")
        )
    )


def round_event(
    task_id: str,
    *,
    round_result: dict[str, Any] | None = None,
    round_count: int | None = None,
    continuation_session_id: str | None = None,
    clear_continuation: bool = False,
) -> dict[str, Any]:
    """Record a round's verdict and the thread a continuation would resume."""
    return relay_task_event(
        "task.round",
        task_id,
        {
            **({"roundResult": round_result} if round_result is not None else {}),
            **({"roundCount": round_count} if round_count is not None else {}),
            **(
                {"continuationSessionId": continuation_session_id}
                if continuation_session_id is not None
                else {}
            ),
            **({"clearContinuation": True} if clear_continuation else {}),
        },
    )


def dispatch_outcome_event(
    task_id: str,
    state: str,
    *,
    code: str | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    return relay_task_event(
        "task.dispatch_outcome",
        task_id,
        {
            "outcome": {
                "state": state,
                **({"code": code} if code else {}),
                **({"message": message} if message else {}),
            }
        },
    )


def dispatch_retry_event(
    task_id: str,
    *,
    failure_count: int,
    next_attempt_at: str,
    code: str | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    return relay_task_event(
        "task.dispatch_retry",
        task_id,
        {
            "retry": {
                "failureCount": failure_count,
                "nextAttemptAt": next_attempt_at,
                **({"code": code} if code else {}),
                **({"message": message} if message else {}),
            }
        },
    )


def dispatch_retry_cleared_event(task_id: str) -> dict[str, Any]:
    return relay_task_event("task.dispatch_retry_cleared", task_id, {})
