from __future__ import annotations

import json
import time
from collections.abc import Callable
from datetime import date as _date
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from loguru import logger
from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Table,
    Text,
    UniqueConstraint,
    case,
    delete,
    insert,
    inspect,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError

from ..core.ids import new_relay_id
from .protocols import TaskDispatchAssignment
from .store_common import (
    DEFAULT_RELAY_DATA_DIR,
    AgentName,
    _append_jsonl,
    _parse_iso,
    _read_json,
    _read_jsonl,
    _write_json,
    create_all_tables,
    database_id_column,
    entity_uuid_type,
    json_type,
    materialize_task_events,
    new_database_id,
    now_iso,
    relay_task_event,
    shared_engine,
    store_transaction,
)
from .store_common import (
    metadata as shared_metadata,
)


class TaskExecutionActiveError(RuntimeError):
    pass


class _TaskWriteConflict(RuntimeError):
    pass


def compact_task_summary(
    task: dict[str, Any],
    *,
    event_count: int | None = None,
    activity_count: int | None = None,
) -> dict[str, Any]:
    """Return an explicit task-list projection without authoritative histories."""
    events = task.get("events") or []
    activity = task.get("activity") or []
    summary = {
        key: value
        for key, value in task.items()
        if key not in {"events", "activity"}
    }
    summary["eventCount"] = len(events) if event_count is None else event_count
    summary["activityCount"] = (
        len(activity) if activity_count is None else activity_count
    )
    if activity:
        summary["lastActivity"] = activity[-1]
    return summary


def compact_task_snapshot(
    task: dict[str, Any], *, event_count: int | None = None
) -> dict[str, Any]:
    """Persist current task state without duplicating event/activity history."""
    snapshot = {
        key: value
        for key, value in task.items()
        if key not in {"events", "activity", "eventCount", "activityCount"}
    }
    events = task.get("events") or []
    activity = task.get("activity") or []
    snapshot["eventCount"] = len(events) if event_count is None else event_count
    snapshot["activityCount"] = len(activity)
    if activity:
        snapshot["lastActivity"] = activity[-1]
    else:
        snapshot.pop("lastActivity", None)
    return snapshot


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
    }
    for field in (
        "ownerEmployeeId",
        "assigneeEmployeeId",
        "projectId",
        "dueDate",
        "routineType",
        "routineCadence",
        "routineNextRunDate",
        "sourceRoutineId",
        "scheduledFor",
    ):
        if payload.get(field):
            created_payload[field] = payload[field]
    for field in ("isRoutine", "routineEnabled"):
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
            "assigneeEmployeeId",
            "dueDate",
            "isRoutine",
            "routineType",
            "routineCadence",
            "routineNextRunDate",
            "routineEnabled",
        )
    }
    events = [relay_task_event("task.updated", task_id, updated)]
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
        events.append(
            relay_task_event("task.status", task_id, {"status": payload["status"]})
        )
    return events


class LocalTaskStore:
    def __init__(self, root_dir: str | Path = DEFAULT_RELAY_DATA_DIR):
        self.root_dir = Path(root_dir)
        self.tasks_dir = self.root_dir / "tasks"
        self._lock = RLock()
        self.tasks_dir.mkdir(parents=True, exist_ok=True)

    def create_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            task_id = new_database_id()
            self._task_dir(task_id).mkdir(parents=True, exist_ok=True)
            logger.debug("Creating task", task_id=task_id, title=payload.get("title"))
            events = task_creation_events(task_id, payload)
            task = materialize_task_events(events)
            self._events_path(task_id).write_text(
                "".join(
                    json.dumps(item, separators=(",", ":")) + "\n" for item in events
                ),
                encoding="utf-8",
            )
            _write_json(self._snapshot_path(task_id), compact_task_snapshot(task))
            return task

    def append_event(self, task_id: str, event: dict[str, Any]) -> dict[str, Any]:
        return self.append_events(task_id, [event])

    def append_events(
        self,
        task_id: str,
        new_events: list[dict[str, Any]],
        *,
        skip_linked_session_id: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            current = self.get_task(task_id)
            if skip_linked_session_id and current.get("deletedAt"):
                return current
            if skip_linked_session_id and skip_linked_session_id in current.get(
                "linkedSessionIds", []
            ):
                return current
            self._task_dir(task_id).mkdir(parents=True, exist_ok=True)
            for event in new_events:
                _append_jsonl(self._events_path(task_id), event)
            logger.debug(
                "Task events appended",
                task_id=task_id,
                event_types=[event.get("type") for event in new_events],
            )
            events = [*current.get("events", []), *new_events]
            task = materialize_task_events(events)
            _write_json(self._snapshot_path(task_id), compact_task_snapshot(task))
            return task

    def get_task(self, task_id: str) -> dict[str, Any]:
        with self._lock:
            events = _read_jsonl(self._events_path(task_id))
            if events:
                return materialize_task_events(events)
            if self._snapshot_path(task_id).exists():
                return _read_json(self._snapshot_path(task_id))
            return materialize_task_events(events)

    def list_tasks(self) -> list[dict[str, Any]]:
        if not self.tasks_dir.exists():
            return []
        tasks = [
            self.get_task(path.name)
            for path in self.tasks_dir.iterdir()
            if path.is_dir()
        ]
        live = [task for task in tasks if not task.get("deletedAt")]
        return sorted(live, key=lambda item: item["updatedAt"], reverse=True)

    def list_task_summaries(
        self, *, employee_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        tasks = self.list_tasks()
        if employee_id is not None:
            tasks = [
                task
                for task in tasks
                if task.get("ownerEmployeeId") == employee_id
                or task.get("assigneeEmployeeId") == employee_id
            ]
        selected = tasks if limit is None else tasks[: max(1, limit)]
        return [compact_task_summary(task) for task in selected]

    def delete_task(
        self,
        task_id: str,
        *,
        deleted_by: str | None = None,
        reject_active_claim: bool = False,
        active_linked_session: Callable[[dict[str, Any]], bool] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            task = self.get_task(task_id)
            if task.get("deletedAt"):
                return task
            if reject_active_claim and dispatch_claim_active(task):
                raise TaskExecutionActiveError("task_execution_active")
            if active_linked_session and active_linked_session(task):
                raise TaskExecutionActiveError("task_execution_active")
            logger.info("Task deleted", task_id=task_id, deleted_by=deleted_by)
            return self.append_event(
                task_id,
                relay_task_event(
                    "task.deleted",
                    task_id,
                    {"actorEmployeeId": deleted_by} if deleted_by else {},
                ),
            )

    def list_due_routines(self, today: str) -> list[dict[str, Any]]:
        tasks = [
            task for task in self.list_tasks() if routine_due_for_promotion(task, today)
        ]
        return sorted(tasks, key=routine_due_sort_key)

    def list_dispatchable_tasks(self, limit: int | None = None) -> list[dict[str, Any]]:
        tasks = [
            task
            for task in self.list_tasks()
            if task.get("status") == "assigned"
            and not task.get("isRoutine")
            and (
                task.get("assignedAgent")
                or task.get("assignedTeamId")
                or task.get("projectId")
            )
            and dispatch_retry_due(task)
        ]
        ordered = sorted(tasks, key=task_claim_sort_key)
        return ordered[:limit] if limit is not None else ordered

    def update_task(
        self,
        task_id: str,
        payload: dict[str, Any],
        *,
        assignment: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.append_events(
            task_id, task_update_events(task_id, payload, assignment=assignment)
        )

    def update_task_if_not_dispatching(
        self,
        task_id: str,
        payload: dict[str, Any],
        *,
        assignment: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if dispatch_claim_active(self.get_task(task_id)):
                raise TaskExecutionActiveError("task_execution_active")
            return self.append_events(
                task_id, task_update_events(task_id, payload, assignment=assignment)
            )

    def claim_next_task_for_agent(
        self, agent: AgentName, assignee_employee_id: str | None = None
    ) -> dict[str, Any] | None:
        candidates = [
            task
            for task in self.list_dispatchable_tasks()
            if task.get("assignedAgent") == agent
            and not task.get("assignedTeamId")
            and (
                not assignee_employee_id
                or task.get("assigneeEmployeeId") == assignee_employee_id
            )
        ]
        for task in sorted(candidates, key=task_claim_sort_key):
            claimed = self.claim_task_for_dispatch(
                task["id"],
                agent,
                message=f"Claimed by {agent}.",
                expected_assignment=TaskDispatchAssignment.capture(task),
            )
            if claimed:
                return claimed
        return None

    def claim_task_for_dispatch(
        self,
        task_id: str,
        agent: AgentName,
        message: str | None = None,
        *,
        expected_assignment: TaskDispatchAssignment | None = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            task = self.get_task(task_id)
            if task.get("deletedAt"):
                return None
            if task.get("status") != "assigned" or (
                task.get("assignedAgent") and task.get("assignedAgent") != agent
            ):
                return None
            if task.get("isRoutine"):
                return None
            if expected_assignment and not expected_assignment.matches(task):
                return None
            if dispatch_claim_active(task):
                return None
            existing_claim = task.get("dispatchClaim")
            if existing_claim:
                logger.info(
                    "Recovering expired task dispatch claim",
                    task_id=task_id,
                    claim_id=existing_claim["id"],
                )
            claim = new_dispatch_claim(
                claim_id=existing_claim.get("id") if existing_claim else None
            )
            claimed = self.append_event(
                task_id,
                relay_task_event("task.dispatch_claimed", task_id, {"claim": claim}),
            )
            logger.debug("Task claimed for dispatch", task_id=task_id, agent=agent)
            self.record_activity(
                task_id,
                message or f"Scheduled dispatch claimed by {agent}.",
                {"agent": agent},
            )
            return self.get_task(task_id) if claimed else None

    def release_dispatch_claim(self, task_id: str, claim_id: str) -> dict[str, Any]:
        return self.append_event(
            task_id,
            relay_task_event("task.dispatch_released", task_id, {"claimId": claim_id}),
        )

    def record_round(
        self,
        task_id: str,
        *,
        round_result: dict[str, Any] | None = None,
        round_count: int | None = None,
        continuation_session_id: str | None = None,
        clear_continuation: bool = False,
    ) -> dict[str, Any]:
        return self.append_event(
            task_id,
            round_event(
                task_id,
                round_result=round_result,
                round_count=round_count,
                continuation_session_id=continuation_session_id,
                clear_continuation=clear_continuation,
            ),
        )

    def record_dispatch_outcome(
        self,
        task_id: str,
        state: str,
        *,
        code: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        return self.append_event(
            task_id,
            dispatch_outcome_event(task_id, state, code=code, message=message),
        )

    def record_dispatch_retry(
        self,
        task_id: str,
        *,
        failure_count: int,
        next_attempt_at: str,
        code: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        return self.append_event(
            task_id,
            dispatch_retry_event(
                task_id,
                failure_count=failure_count,
                next_attempt_at=next_attempt_at,
                code=code,
                message=message,
            ),
        )

    def clear_dispatch_retry(self, task_id: str) -> dict[str, Any]:
        return self.append_event(task_id, dispatch_retry_cleared_event(task_id))

    def promote_due_routine(
        self,
        task_id: str,
        today: str,
        next_run_date: str | None,
        *,
        agent_override: AgentName | None = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            routine = self.get_task(task_id)
            if routine.get("deletedAt"):
                return None
            if not routine_due_for_promotion(routine, today):
                return None
            agent = routine.get("assignedAgent") or agent_override
            if not agent and not (
                routine.get("assignedTeamId") or routine.get("projectId")
            ):
                return None
            occurrence_events = routine_occurrence_events(routine, agent)
            occurrence = materialize_task_events(occurrence_events)
            self._task_dir(occurrence["id"]).mkdir(parents=True, exist_ok=True)
            self._events_path(occurrence["id"]).write_text(
                "".join(
                    json.dumps(item, separators=(",", ":")) + "\n"
                    for item in occurrence_events
                ),
                encoding="utf-8",
            )
            _write_json(self._snapshot_path(occurrence["id"]), occurrence)

            routine_events = routine_promotion_events(
                routine["id"],
                occurrence["id"],
                agent,
                routine["routineNextRunDate"],
                next_run_date,
            )
            for event in routine_events:
                _append_jsonl(self._events_path(task_id), event)
            updated = materialize_task_events(
                [*routine.get("events", []), *routine_events]
            )
            _write_json(self._snapshot_path(task_id), updated)
            logger.debug(
                "Due routine promoted",
                task_id=task_id,
                occurrence_id=occurrence["id"],
                agent=agent,
            )
            return occurrence

    def create_routine_occurrence(
        self,
        routine_id: str,
        scheduled_for: str,
        *,
        agent_override: AgentName | None = None,
    ) -> dict[str, Any] | None:
        with self._lock:
            routine = self.get_task(routine_id)
            if routine.get("deletedAt"):
                return None
            existing = _open_routine_occurrence(
                routine,
                self.get_task,
                scheduled_for=scheduled_for,
            )
            if existing:
                return existing
            agent = routine.get("assignedAgent") or agent_override
            occurrence_events = routine_occurrence_events(
                routine, agent, scheduled_for=scheduled_for
            )
            occurrence = materialize_task_events(occurrence_events)
            self._task_dir(occurrence["id"]).mkdir(parents=True, exist_ok=True)
            self._events_path(occurrence["id"]).write_text(
                "".join(
                    json.dumps(item, separators=(",", ":")) + "\n"
                    for item in occurrence_events
                ),
                encoding="utf-8",
            )
            _write_json(self._snapshot_path(occurrence["id"]), occurrence)
            event = relay_task_event(
                "task.occurrence_created",
                routine_id,
                {"occurrenceId": occurrence["id"], "scheduledFor": scheduled_for},
            )
            _append_jsonl(self._events_path(routine_id), event)
            updated = materialize_task_events([*routine.get("events", []), event])
            _write_json(self._snapshot_path(routine_id), updated)
            return occurrence

    def assign_task(
        self, task_id: str, agent: AgentName, agent_id: str | None = None
    ) -> dict[str, Any]:
        self.append_event(
            task_id,
            relay_task_event(
                "task.assigned",
                task_id,
                {
                    "agent": agent,
                    **({"agentId": agent_id} if agent_id else {}),
                },
            ),
        )
        self.append_event(
            task_id, relay_task_event("task.status", task_id, {"status": "assigned"})
        )
        logger.debug("Task assigned", task_id=task_id, agent=agent)
        return self.record_activity(task_id, f"Assigned to {agent}.", {"agent": agent})

    def set_task_assignment(
        self, task_id: str, agent: AgentName, agent_id: str
    ) -> dict[str, Any]:
        self.append_event(
            task_id,
            relay_task_event(
                "task.assigned", task_id, {"agent": agent, "agentId": agent_id}
            ),
        )
        return self.record_activity(
            task_id, f"Assigned to logical agent {agent_id}.", {"agent": agent}
        )

    def set_task_team_assignment(self, task_id: str, team_id: str) -> dict[str, Any]:
        self.append_event(
            task_id,
            relay_task_event("task.assigned", task_id, {"teamId": team_id}),
        )
        return self.record_activity(task_id, f"Assigned to team {team_id}.")

    def unassign_task(self, task_id: str) -> dict[str, Any]:
        self.append_event(task_id, relay_task_event("task.unassigned", task_id, {}))
        return self.record_activity(task_id, "Agent assignment cleared.")

    def link_session(self, task_id: str, session_id: str) -> dict[str, Any]:
        task = self.append_events(
            task_id,
            _task_session_link_events(task_id, session_id),
            skip_linked_session_id=session_id,
        )
        logger.debug("Task linked to session", task_id=task_id, session_id=session_id)
        return task

    def unlink_session(self, task_id: str, session_id: str) -> dict[str, Any]:
        task = self.get_task(task_id)
        if session_id not in task.get("linkedSessionIds", []):
            return task
        return self.append_events(
            task_id, _task_session_unlink_events(task_id, session_id)
        )

    def record_activity(
        self, task_id: str, message: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        extras = payload or {}
        logger.debug("Task activity recorded", task_id=task_id, message=message)
        return self.append_event(
            task_id,
            relay_task_event(
                "task.activity",
                task_id,
                {
                    "activity": {
                        "id": new_relay_id("act"),
                        "createdAt": now_iso(),
                        "message": message,
                        **({"agent": extras["agent"]} if extras.get("agent") else {}),
                        **(
                            {"sessionId": extras["sessionId"]}
                            if extras.get("sessionId")
                            else {}
                        ),
                    }
                },
            ),
        )

    def _task_dir(self, task_id: str) -> Path:
        return self.tasks_dir / Path(task_id).name

    def _events_path(self, task_id: str) -> Path:
        return self._task_dir(task_id) / "events.jsonl"

    def _snapshot_path(self, task_id: str) -> Path:
        return self._task_dir(task_id) / "snapshot.json"


class DatabaseTaskStore:
    metadata = shared_metadata

    tasks = Table(
        "tasks",
        metadata,
        database_id_column(),
        Column("title", Text, nullable=False),
        Column("description", Text, nullable=False),
        Column("priority", Text, nullable=False),
        Column("status", Text, nullable=False),
        Column("assigned_agent", Text, nullable=True),
        Column("assigned_agent_id", entity_uuid_type(), nullable=True),
        Column("assigned_team_id", entity_uuid_type(), nullable=True),
        Column(
            "project_id",
            entity_uuid_type(),
            ForeignKey("projects.id", ondelete="RESTRICT", name="fk_tasks_project"),
            nullable=True,
        ),
        Column("owner_employee_id", entity_uuid_type(), nullable=True),
        Column("assignee_employee_id", entity_uuid_type(), nullable=True),
        Column("due_date", Date, nullable=True),
        Column("is_routine", Boolean, nullable=False, default=False),
        Column("routine_type", Text, nullable=True),
        Column("routine_cadence", Text, nullable=True),
        Column("routine_next_run_date", Date, nullable=True),
        Column("routine_enabled", Boolean, nullable=False, default=False),
        Column("dispatch_failure_count", Integer, nullable=False, default=0),
        Column("dispatch_next_attempt_at", DateTime(timezone=True), nullable=True),
        Column("snapshot", json_type(), nullable=False),
        Column("version", BigInteger, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Index("ix_tasks_created_at", "created_at"),
        Index("ix_tasks_updated_at", "updated_at"),
        Index("ix_tasks_status", "status"),
        Index("ix_tasks_assigned_agent", "assigned_agent"),
        Index("ix_tasks_assigned_agent_id", "assigned_agent_id"),
        Index("ix_tasks_assigned_team_id", "assigned_team_id"),
        Index("ix_tasks_project_id", "project_id"),
        Index("ix_tasks_owner_employee_id", "owner_employee_id"),
        Index("ix_tasks_assignee_employee_id", "assignee_employee_id"),
        Index("ix_tasks_owner_updated_at", "owner_employee_id", "updated_at"),
        Index("ix_tasks_assignee_updated_at", "assignee_employee_id", "updated_at"),
        Index("ix_tasks_due_date", "due_date"),
        Index("ix_tasks_priority", "priority"),
        Index("ix_tasks_is_routine", "is_routine"),
        Index("ix_tasks_routine_next_run_date", "routine_next_run_date"),
        Index("ix_tasks_routine_enabled", "routine_enabled"),
        Index(
            "ix_tasks_dispatch_eligibility",
            "status",
            "is_routine",
            "dispatch_next_attempt_at",
            "priority",
            "due_date",
            "created_at",
        ),
    )
    events = Table(
        "task_events",
        metadata,
        database_id_column(),
        Column(
            "task_id",
            entity_uuid_type(),
            ForeignKey("tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("sequence", BigInteger, nullable=False),
        Column("type", Text, nullable=False),
        Column("timestamp", DateTime(timezone=True), nullable=False),
        Column("payload", json_type(), nullable=False),
        UniqueConstraint("task_id", "sequence", name="uq_task_events_task_sequence"),
        Index("ix_task_events_task_id", "task_id"),
        Index("ix_task_events_timestamp", "timestamp"),
    )
    task_sessions = Table(
        "task_sessions",
        metadata,
        database_id_column(),
        Column(
            "task_id",
            entity_uuid_type(),
            ForeignKey("tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("session_id", entity_uuid_type(), nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        UniqueConstraint("task_id", "session_id", name="uq_task_sessions_task_session"),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def verify_schema(self) -> None:
        schema = inspect(self.engine)
        required_tables = {"tasks", "task_events", "task_sessions"}
        missing = required_tables.difference(schema.get_table_names())
        if missing:
            raise RuntimeError(
                f"Database is missing required task tables: {', '.join(sorted(missing))}."
            )
        required_columns = {
            table.name: set(table.c.keys())
            for table in (self.tasks, self.events, self.task_sessions)
        }
        for table_name, expected in required_columns.items():
            actual = {column["name"] for column in schema.get_columns(table_name)}
            absent = expected.difference(actual)
            if absent:
                raise RuntimeError(
                    f"Database table {table_name} is missing required columns: "
                    f"{', '.join(sorted(absent))}."
                )
        required_unique_constraints = {
            "task_events": {("task_id", "sequence")},
            "task_sessions": {("task_id", "session_id")},
        }
        for table_name, expected in required_unique_constraints.items():
            actual = {
                tuple(constraint.get("column_names") or ())
                for constraint in schema.get_unique_constraints(table_name)
            }
            absent = expected.difference(actual)
            if absent:
                rendered = ", ".join(
                    "(" + ", ".join(item) + ")" for item in sorted(absent)
                )
                raise RuntimeError(
                    f"Database table {table_name} is missing required unique "
                    f"constraints: {rendered}."
                )

    def create_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        task_id = new_database_id()
        logger.debug(
            "Creating database task", task_id=task_id, title=payload.get("title")
        )
        events = task_creation_events(task_id, payload)
        task = materialize_task_events(events)
        with store_transaction(self.engine) as conn:
            task_row = task_to_row(task, version=len(events))
            conn.execute(insert(self.tasks).values(**task_row))
            for sequence, event in enumerate(events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(task_row["id"], sequence, event)
                    )
                )
        return task

    def append_event(self, task_id: str, event: dict[str, Any]) -> dict[str, Any]:
        return self.append_events(task_id, [event])

    def append_events(
        self,
        task_id: str,
        events: list[dict[str, Any]],
        *,
        skip_linked_session_id: str | None = None,
        reject_active_claim: bool = False,
        active_linked_session: Callable[[dict[str, Any]], bool] | None = None,
    ) -> dict[str, Any]:
        for attempt in range(3):
            try:
                return self._append_events_once(
                    task_id,
                    events,
                    skip_linked_session_id=skip_linked_session_id,
                    reject_active_claim=reject_active_claim,
                    active_linked_session=active_linked_session,
                )
            except (IntegrityError, _TaskWriteConflict):
                if attempt == 2:
                    raise
                time.sleep(0.01 * (attempt + 1))
        raise RuntimeError("unreachable")

    def _append_events_once(
        self,
        task_id: str,
        events: list[dict[str, Any]],
        *,
        skip_linked_session_id: str | None = None,
        reject_active_claim: bool = False,
        active_linked_session: Callable[[dict[str, Any]], bool] | None = None,
    ) -> dict[str, Any]:
        with store_transaction(self.engine) as conn:
            if skip_linked_session_id:
                self._lock_session_for_link(conn, skip_linked_session_id)
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version)
                    .where(self.tasks.c.id == task_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(task_id)
            task_pk = row["id"]
            sequence = int(row["version"] or 0)
            current = row["snapshot"] or {}
            deleting = any(event.get("type") == "task.deleted" for event in events)
            if deleting and current.get("deletedAt"):
                return current
            if skip_linked_session_id and current.get("deletedAt"):
                return current
            if reject_active_claim and dispatch_claim_active(current):
                raise TaskExecutionActiveError("task_execution_active")
            if active_linked_session and active_linked_session(current):
                raise TaskExecutionActiveError("task_execution_active")
            if skip_linked_session_id and skip_linked_session_id in current.get(
                "linkedSessionIds", []
            ):
                return current
            existing_events = self._events_for_task(conn, task_pk)
            if not existing_events:
                existing_events = list(current.get("events", []))
            task = materialize_task_events([*existing_events, *events])
            claimed = conn.execute(
                update(self.tasks)
                .where(
                    self.tasks.c.id == task_pk,
                    self.tasks.c.version == sequence,
                )
                .values(
                    **task_to_row(
                        task,
                        version=sequence + len(events),
                        database_id=task_pk,
                    )
                )
            )
            if claimed.rowcount != 1:
                raise _TaskWriteConflict(task_id)
            for offset, event in enumerate(events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(task_pk, sequence + offset, event)
                    )
                )
                if event.get("type") == "task.session_linked":
                    self._ensure_task_session(
                        conn, task_pk, event["sessionId"], event["timestamp"]
                    )
                elif event.get("type") == "task.session_unlinked":
                    conn.execute(
                        delete(self.task_sessions)
                        .where(self.task_sessions.c.task_id == task_pk)
                        .where(self.task_sessions.c.session_id == event["sessionId"])
                    )
        logger.debug(
            "Database task events appended",
            task_id=task_id,
            event_types=[event.get("type") for event in events],
        )
        return task

    def _lock_session_for_link(self, conn: Any, session_id: str) -> None:
        lock_clause = "" if self.engine.dialect.name == "sqlite" else " FOR KEY SHARE"
        session_pk = conn.scalar(
            text("SELECT id FROM sessions WHERE id = :session_id" + lock_clause),
            {"session_id": session_id},
        )
        if not session_pk:
            raise KeyError(f"Unknown session {session_id}.")

    def get_task(self, task_id: str) -> dict[str, Any]:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot).where(
                        self.tasks.c.id == task_id
                    )
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(task_id)
            events = self._events_for_task(conn, row["id"])
            if not events:
                events = list((row["snapshot"] or {}).get("events", []))
            return materialize_task_events(events) if events else row["snapshot"]

    def list_tasks(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot).order_by(
                        self.tasks.c.updated_at.desc()
                    )
                )
                .mappings()
                .all()
            )
            tasks = []
            for row in rows:
                events = self._events_for_task(conn, row["id"])
                task = materialize_task_events(events) if events else row["snapshot"]
                if not task.get("deletedAt"):
                    tasks.append(task)
            return tasks

    def list_task_summaries(
        self, *, employee_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]:
        statement = (
            select(
                self.tasks.c.snapshot.label("summary"),
                self.tasks.c.version,
            )
            .where(self.tasks.c.snapshot["deletedAt"].as_string().is_(None))
            .order_by(self.tasks.c.updated_at.desc())
        )
        if employee_id is not None:
            statement = statement.where(
                or_(
                    self.tasks.c.owner_employee_id == employee_id,
                    self.tasks.c.assignee_employee_id == employee_id,
                )
            )
        if limit is not None:
            statement = statement.limit(max(1, limit))
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [
            {
                **compact_task_summary(
                    row["summary"],
                    event_count=int(row["version"] or 0),
                    activity_count=int(row["summary"].get("activityCount") or 0),
                ),
                **(
                    {"lastActivity": row["summary"]["lastActivity"]}
                    if row["summary"].get("lastActivity")
                    else {}
                ),
            }
            for row in rows
        ]

    def delete_task(
        self,
        task_id: str,
        *,
        deleted_by: str | None = None,
        reject_active_claim: bool = False,
        active_linked_session: Callable[[dict[str, Any]], bool] | None = None,
    ) -> dict[str, Any]:
        task = self.get_task(task_id)
        if task.get("deletedAt"):
            return task
        logger.info("Database task deleted", task_id=task_id, deleted_by=deleted_by)
        return self.append_events(
            task_id,
            [
                relay_task_event(
                    "task.deleted",
                    task_id,
                    {"actorEmployeeId": deleted_by} if deleted_by else {},
                )
            ],
            reject_active_claim=reject_active_claim,
            active_linked_session=active_linked_session,
        )

    def list_due_routines(self, today: str) -> list[dict[str, Any]]:
        try:
            today_date = _parse_date(today)
        except ValueError:
            return []
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.tasks.c.snapshot)
                    .where(self.tasks.c.is_routine.is_(True))
                    .where(self.tasks.c.routine_enabled.is_(True))
                    .where(self.tasks.c.routine_next_run_date.is_not(None))
                    .where(self.tasks.c.routine_next_run_date <= today_date)
                    .order_by(
                        self.tasks.c.routine_next_run_date.asc(),
                        _priority_order_expression(),
                        self.tasks.c.created_at.asc(),
                    )
                )
                .mappings()
                .all()
            )
        return [
            row["snapshot"]
            for row in rows
            if not row["snapshot"].get("deletedAt")
            and routine_due_for_promotion(row["snapshot"], today)
        ]

    def list_dispatchable_tasks(self, limit: int | None = None) -> list[dict[str, Any]]:
        statement = (
            select(self.tasks.c.snapshot)
            .where(self.tasks.c.status == "assigned")
            .where(
                or_(
                    self.tasks.c.assigned_agent.is_not(None),
                    self.tasks.c.assigned_team_id.is_not(None),
                    self.tasks.c.project_id.is_not(None),
                )
            )
            .where(self.tasks.c.is_routine.is_(False))
            .where(
                or_(
                    self.tasks.c.dispatch_next_attempt_at.is_(None),
                    self.tasks.c.dispatch_next_attempt_at <= datetime.now(timezone.utc),
                )
            )
            .order_by(
                _priority_order_expression(),
                _due_date_missing_expression(),
                self.tasks.c.due_date.asc(),
                self.tasks.c.created_at.asc(),
            )
        )
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        live = [row["snapshot"] for row in rows if not row["snapshot"].get("deletedAt")]
        return live[:limit] if limit is not None else live

    def update_task(
        self,
        task_id: str,
        payload: dict[str, Any],
        *,
        assignment: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.append_events(
            task_id,
            task_update_events(task_id, payload, assignment=assignment),
        )

    def update_task_if_not_dispatching(
        self,
        task_id: str,
        payload: dict[str, Any],
        *,
        assignment: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.append_events(
            task_id,
            task_update_events(task_id, payload, assignment=assignment),
            reject_active_claim=True,
        )

    def claim_next_task_for_agent(
        self, agent: AgentName, assignee_employee_id: str | None = None
    ) -> dict[str, Any] | None:
        candidates = [
            task
            for task in self.list_dispatchable_tasks()
            if task.get("assignedAgent") == agent
            and not task.get("assignedTeamId")
            and (
                not assignee_employee_id
                or task.get("assigneeEmployeeId") == assignee_employee_id
            )
        ]
        for task in sorted(candidates, key=task_claim_sort_key):
            claimed = self.claim_task_for_dispatch(
                task["id"],
                agent,
                message=f"Claimed by {agent}.",
                expected_assignment=TaskDispatchAssignment.capture(task),
            )
            if claimed:
                return claimed
        return None

    def claim_task_for_dispatch(
        self,
        task_id: str,
        agent: AgentName,
        message: str | None = None,
        *,
        expected_assignment: TaskDispatchAssignment | None = None,
    ) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version)
                    .where(self.tasks.c.id == task_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            snapshot = row["snapshot"] or {}
            if (
                snapshot.get("deletedAt")
                or snapshot.get("status") != "assigned"
                or (
                    snapshot.get("assignedAgent")
                    and snapshot.get("assignedAgent") != agent
                )
                or snapshot.get("isRoutine")
                or (
                    expected_assignment is not None
                    and not expected_assignment.matches(snapshot)
                )
                or dispatch_claim_active(snapshot)
            ):
                return None
            existing_claim = snapshot.get("dispatchClaim")
            if existing_claim:
                logger.info(
                    "Recovering expired database task dispatch claim",
                    task_id=task_id,
                    claim_id=existing_claim["id"],
                )
            claim = new_dispatch_claim(
                claim_id=existing_claim.get("id") if existing_claim else None
            )
            events = [
                relay_task_event("task.dispatch_claimed", task_id, {"claim": claim}),
                relay_task_event(
                    "task.activity",
                    task_id,
                    {
                        "activity": {
                            "id": new_relay_id("act"),
                            "createdAt": now_iso(),
                            "message": message
                            or f"Scheduled dispatch claimed by {agent}.",
                            "agent": agent,
                        }
                    },
                ),
            ]
            task_pk = row["id"]
            snapshot_events = self._events_for_task(conn, task_pk)
            if not snapshot_events:
                snapshot_events = list(snapshot.get("events", []))
            sequence = int(row["version"] or 0)
            for offset, event in enumerate(events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(task_pk, sequence + offset, event)
                    )
                )
                snapshot_events.append(event)
            claimed = materialize_task_events(snapshot_events)
            conn.execute(
                update(self.tasks)
                .where(self.tasks.c.id == task_pk)
                .values(
                    **task_to_row(
                        claimed, version=sequence + len(events), database_id=task_pk
                    )
                )
            )
        logger.debug(
            "Database task claimed for scheduled dispatch", task_id=task_id, agent=agent
        )
        return claimed

    def release_dispatch_claim(self, task_id: str, claim_id: str) -> dict[str, Any]:
        return self.append_event(
            task_id,
            relay_task_event("task.dispatch_released", task_id, {"claimId": claim_id}),
        )

    def record_round(
        self,
        task_id: str,
        *,
        round_result: dict[str, Any] | None = None,
        round_count: int | None = None,
        continuation_session_id: str | None = None,
        clear_continuation: bool = False,
    ) -> dict[str, Any]:
        return self.append_event(
            task_id,
            round_event(
                task_id,
                round_result=round_result,
                round_count=round_count,
                continuation_session_id=continuation_session_id,
                clear_continuation=clear_continuation,
            ),
        )

    def record_dispatch_outcome(
        self,
        task_id: str,
        state: str,
        *,
        code: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        return self.append_event(
            task_id,
            dispatch_outcome_event(task_id, state, code=code, message=message),
        )

    def record_dispatch_retry(
        self,
        task_id: str,
        *,
        failure_count: int,
        next_attempt_at: str,
        code: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]:
        return self.append_event(
            task_id,
            dispatch_retry_event(
                task_id,
                failure_count=failure_count,
                next_attempt_at=next_attempt_at,
                code=code,
                message=message,
            ),
        )

    def clear_dispatch_retry(self, task_id: str) -> dict[str, Any]:
        return self.append_event(task_id, dispatch_retry_cleared_event(task_id))

    def promote_due_routine(
        self,
        task_id: str,
        today: str,
        next_run_date: str | None,
        *,
        agent_override: AgentName | None = None,
    ) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version)
                    .where(self.tasks.c.id == task_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            routine = row["snapshot"] or {}
            if routine.get("deletedAt"):
                return None
            if not routine_due_for_promotion(routine, today):
                return None
            agent = routine.get("assignedAgent") or agent_override
            if not agent and not (
                routine.get("assignedTeamId") or routine.get("projectId")
            ):
                return None

            occurrence_events = routine_occurrence_events(routine, agent)
            occurrence = materialize_task_events(occurrence_events)
            occurrence_row = task_to_row(occurrence, version=len(occurrence_events))
            conn.execute(insert(self.tasks).values(**occurrence_row))
            for sequence, event in enumerate(occurrence_events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(occurrence_row["id"], sequence, event)
                    )
                )

            routine_events = routine_promotion_events(
                task_id,
                occurrence["id"],
                agent,
                routine["routineNextRunDate"],
                next_run_date,
            )
            task_pk = row["id"]
            snapshot_events = self._events_for_task(conn, task_pk)
            if not snapshot_events:
                snapshot_events = list(routine.get("events", []))
            sequence = int(row["version"] or 0)
            for offset, event in enumerate(routine_events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(task_pk, sequence + offset, event)
                    )
                )
                snapshot_events.append(event)
            updated = materialize_task_events(snapshot_events)
            conn.execute(
                update(self.tasks)
                .where(self.tasks.c.id == task_pk)
                .values(
                    **task_to_row(
                        updated,
                        version=sequence + len(routine_events),
                        database_id=task_pk,
                    )
                )
            )
        logger.debug(
            "Database due routine promoted",
            task_id=task_id,
            occurrence_id=occurrence["id"],
            agent=agent,
        )
        return occurrence

    def create_routine_occurrence(
        self,
        routine_id: str,
        scheduled_for: str,
        *,
        agent_override: AgentName | None = None,
    ) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version)
                    .where(self.tasks.c.id == routine_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(routine_id)
            compact_routine = row["snapshot"] or {}
            prior_events = self._events_for_task(conn, row["id"])
            if not prior_events:
                prior_events = list(compact_routine.get("events", []))
            routine = (
                materialize_task_events(prior_events)
                if prior_events
                else compact_routine
            )
            if routine.get("deletedAt"):
                return None

            def load_occurrence(occurrence_id: str) -> dict[str, Any]:
                occurrence_row = (
                    conn.execute(
                        select(self.tasks.c.snapshot).where(
                            self.tasks.c.id == occurrence_id
                        )
                    )
                    .mappings()
                    .first()
                )
                if not occurrence_row:
                    raise KeyError(occurrence_id)
                return occurrence_row["snapshot"]

            existing = _open_routine_occurrence(
                routine,
                load_occurrence,
                scheduled_for=scheduled_for,
            )
            if existing:
                return existing

            agent = routine.get("assignedAgent") or agent_override
            occurrence_events = routine_occurrence_events(
                routine, agent, scheduled_for=scheduled_for
            )
            occurrence = materialize_task_events(occurrence_events)
            occurrence_row = task_to_row(occurrence, version=len(occurrence_events))
            conn.execute(insert(self.tasks).values(**occurrence_row))
            for sequence, occurrence_event in enumerate(occurrence_events):
                conn.execute(
                    insert(self.events).values(
                        **task_event_to_row(
                            occurrence_row["id"], sequence, occurrence_event
                        )
                    )
                )

            event = relay_task_event(
                "task.occurrence_created",
                routine_id,
                {"occurrenceId": occurrence["id"], "scheduledFor": scheduled_for},
            )
            task_pk = row["id"]
            sequence = int(row["version"] or 0)
            conn.execute(
                insert(self.events).values(
                    **task_event_to_row(task_pk, sequence, event)
                )
            )
            updated = materialize_task_events([*prior_events, event])
            conn.execute(
                update(self.tasks)
                .where(self.tasks.c.id == task_pk)
                .values(
                    **task_to_row(
                        updated,
                        version=sequence + 1,
                        database_id=task_pk,
                    )
                )
            )
        return occurrence

    def assign_task(
        self, task_id: str, agent: AgentName, agent_id: str | None = None
    ) -> dict[str, Any]:
        self.append_event(
            task_id,
            relay_task_event(
                "task.assigned",
                task_id,
                {
                    "agent": agent,
                    **({"agentId": agent_id} if agent_id else {}),
                },
            ),
        )
        self.append_event(
            task_id, relay_task_event("task.status", task_id, {"status": "assigned"})
        )
        logger.debug("Database task assigned", task_id=task_id, agent=agent)
        return self.record_activity(task_id, f"Assigned to {agent}.", {"agent": agent})

    def set_task_assignment(
        self, task_id: str, agent: AgentName, agent_id: str
    ) -> dict[str, Any]:
        self.append_event(
            task_id,
            relay_task_event(
                "task.assigned", task_id, {"agent": agent, "agentId": agent_id}
            ),
        )
        return self.record_activity(
            task_id, f"Assigned to logical agent {agent_id}.", {"agent": agent}
        )

    def set_task_team_assignment(self, task_id: str, team_id: str) -> dict[str, Any]:
        self.append_event(
            task_id,
            relay_task_event("task.assigned", task_id, {"teamId": team_id}),
        )
        return self.record_activity(task_id, f"Assigned to team {team_id}.")

    def unassign_task(self, task_id: str) -> dict[str, Any]:
        self.append_event(task_id, relay_task_event("task.unassigned", task_id, {}))
        return self.record_activity(task_id, "Agent assignment cleared.")

    def link_session(self, task_id: str, session_id: str) -> dict[str, Any]:
        task = self.append_events(
            task_id,
            _task_session_link_events(task_id, session_id),
            skip_linked_session_id=session_id,
        )
        logger.debug(
            "Database task linked to session",
            task_id=task_id,
            session_id=session_id,
        )
        return task

    def unlink_session(self, task_id: str, session_id: str) -> dict[str, Any]:
        task = self.get_task(task_id)
        if session_id not in task.get("linkedSessionIds", []):
            return task
        return self.append_events(
            task_id, _task_session_unlink_events(task_id, session_id)
        )

    def unlink_session_in_transaction(
        self, conn: Any, task_id: str, session_id: str
    ) -> dict[str, Any]:
        row = (
            conn.execute(
                select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version)
                .where(self.tasks.c.id == task_id)
                .with_for_update()
            )
            .mappings()
            .first()
        )
        if not row:
            raise KeyError(task_id)
        current = row["snapshot"] or {}
        if session_id not in current.get("linkedSessionIds", []):
            return current
        events = _task_session_unlink_events(task_id, session_id)
        sequence = int(row["version"] or 0)
        prior_events = self._events_for_task(conn, row["id"])
        if not prior_events:
            prior_events = list(current.get("events", []))
        task = materialize_task_events([*prior_events, *events])
        claimed = conn.execute(
            update(self.tasks)
            .where(self.tasks.c.id == row["id"], self.tasks.c.version == sequence)
            .values(
                **task_to_row(
                    task,
                    version=sequence + len(events),
                    database_id=row["id"],
                )
            )
        )
        if claimed.rowcount != 1:
            raise _TaskWriteConflict(task_id)
        for offset, event in enumerate(events):
            conn.execute(
                insert(self.events).values(
                    **task_event_to_row(row["id"], sequence + offset, event)
                )
            )
        conn.execute(
            delete(self.task_sessions)
            .where(self.task_sessions.c.task_id == row["id"])
            .where(self.task_sessions.c.session_id == session_id)
        )
        return task

    def record_activity(
        self, task_id: str, message: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        extras = payload or {}
        logger.debug(
            "Database task activity recorded", task_id=task_id, message=message
        )
        return self.append_event(
            task_id,
            relay_task_event(
                "task.activity",
                task_id,
                {
                    "activity": {
                        "id": new_relay_id("act"),
                        "createdAt": now_iso(),
                        "message": message,
                        **({"agent": extras["agent"]} if extras.get("agent") else {}),
                        **(
                            {"sessionId": extras["sessionId"]}
                            if extras.get("sessionId")
                            else {}
                        ),
                    }
                },
            ),
        )

    def _task_pk(self, conn: Any, task_id: str, *, lock: bool = False) -> str:
        statement = select(self.tasks.c.id).where(self.tasks.c.id == task_id)
        if lock:
            statement = statement.with_for_update()
        task_pk = conn.scalar(statement)
        if not task_pk:
            raise KeyError(task_id)
        return task_pk

    def _events_for_task(self, conn: Any, task_pk: str) -> list[dict[str, Any]]:
        rows = (
            conn.execute(
                select(self.events.c.payload)
                .where(self.events.c.task_id == task_pk)
                .order_by(self.events.c.sequence)
            )
            .mappings()
            .all()
        )
        return [row["payload"] for row in rows]

    def _ensure_task_session(
        self, conn: Any, task_pk: str, session_id: str, timestamp: str
    ) -> None:
        existing = conn.execute(
            select(self.task_sessions.c.task_id)
            .where(self.task_sessions.c.task_id == task_pk)
            .where(self.task_sessions.c.session_id == session_id)
        ).first()
        if not existing:
            conn.execute(
                insert(self.task_sessions).values(
                    id=new_database_id(),
                    task_id=task_pk,
                    session_id=session_id,
                    created_at=_parse_iso(timestamp),
                )
            )


def task_to_row(
    task: dict[str, Any], *, version: int, database_id: str | None = None
) -> dict[str, Any]:
    return {
        "id": database_id or task["id"],
        "title": task["title"],
        "description": task.get("description", ""),
        "priority": task.get("priority", "normal"),
        "status": task["status"],
        "assigned_agent": task.get("assignedAgent"),
        "assigned_agent_id": task.get("assignedAgentId"),
        "assigned_team_id": task.get("assignedTeamId"),
        "project_id": task.get("projectId"),
        "owner_employee_id": task.get("ownerEmployeeId"),
        "assignee_employee_id": task.get("assigneeEmployeeId"),
        "due_date": _parse_date(task.get("dueDate")),
        "is_routine": bool(task.get("isRoutine")),
        "routine_type": task.get("routineType"),
        "routine_cadence": task.get("routineCadence"),
        "routine_next_run_date": _parse_date(task.get("routineNextRunDate")),
        "routine_enabled": bool(task.get("routineEnabled")),
        "dispatch_failure_count": int(
            (task.get("dispatchRetry") or {}).get("failureCount") or 0
        ),
        "dispatch_next_attempt_at": _parse_iso(
            (task.get("dispatchRetry") or {}).get("nextAttemptAt")
        ),
        "snapshot": compact_task_snapshot(task, event_count=version),
        "version": version,
        "created_at": _parse_iso(task["createdAt"]),
        "updated_at": _parse_iso(task["updatedAt"]),
    }


def task_event_to_row(
    task_pk: str, sequence: int, event: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": new_database_id(),
        "task_id": task_pk,
        "sequence": sequence,
        "type": event["type"],
        "timestamp": _parse_iso(event["timestamp"]),
        "payload": event,
    }


def _parse_date(value: str | None) -> Any:
    if not value:
        return None
    return _date.fromisoformat(value)


def _priority_rank(priority: Any) -> int:
    return {"high": 0, "normal": 1, "low": 2}.get(priority, 1)


def task_claim_sort_key(task: dict[str, Any]) -> tuple[int, str, str]:
    priority_rank = _priority_rank(task.get("priority"))
    due_date = task.get("dueDate") or "9999-12-31"
    return (priority_rank, due_date, task.get("createdAt") or "")


def routine_due_sort_key(task: dict[str, Any]) -> tuple[str, int, str]:
    return (
        task.get("routineNextRunDate") or "9999-12-31",
        _priority_rank(task.get("priority")),
        task.get("createdAt") or "",
    )


def _priority_order_expression() -> Any:
    return case(
        (DatabaseTaskStore.tasks.c.priority == "high", 0),
        (DatabaseTaskStore.tasks.c.priority == "normal", 1),
        (DatabaseTaskStore.tasks.c.priority == "low", 2),
        else_=1,
    )


def _due_date_missing_expression() -> Any:
    return case((DatabaseTaskStore.tasks.c.due_date.is_(None), 1), else_=0)


def routine_due_for_promotion(routine: dict[str, Any], today: str) -> bool:
    next_run = routine.get("routineNextRunDate")
    if (
        not routine.get("isRoutine")
        or not routine.get("routineEnabled")
        or not next_run
    ):
        return False
    try:
        return _date.fromisoformat(next_run) <= _date.fromisoformat(today)
    except (TypeError, ValueError):
        return False


def routine_occurrence_events(
    routine: dict[str, Any],
    agent: AgentName | None,
    *,
    scheduled_for: str | None = None,
) -> list[dict[str, Any]]:
    occurrence_date = scheduled_for or routine["routineNextRunDate"]
    occurrence_id = new_database_id()
    events = [
        relay_task_event(
            "task.created",
            occurrence_id,
            {
                "title": routine["title"],
                "description": routine.get("description", ""),
                "priority": routine.get("priority", "normal"),
                "dueDate": occurrence_date,
                "sourceRoutineId": routine["id"],
                "scheduledFor": occurrence_date,
                **(
                    {"ownerEmployeeId": routine["ownerEmployeeId"]}
                    if routine.get("ownerEmployeeId")
                    else {}
                ),
                **(
                    {"assigneeEmployeeId": routine["assigneeEmployeeId"]}
                    if routine.get("assigneeEmployeeId")
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


def _open_routine_occurrence(
    routine: dict[str, Any],
    load_task: Any,
    *,
    scheduled_for: str | None = None,
) -> dict[str, Any] | None:
    for event in reversed(routine.get("events", [])):
        if event.get("type") != "task.occurrence_created":
            continue
        if scheduled_for is not None and event.get("scheduledFor") != scheduled_for:
            continue
        occurrence_id = event.get("occurrenceId")
        if not isinstance(occurrence_id, str) or not occurrence_id:
            continue
        try:
            occurrence = load_task(occurrence_id)
        except (KeyError, FileNotFoundError):
            continue
        return occurrence
    return None


def routine_promotion_events(
    routine_id: str,
    occurrence_id: str,
    agent: AgentName | None,
    scheduled_for: str,
    next_run_date: str | None,
) -> list[dict[str, Any]]:
    return [
        relay_task_event(
            "task.occurrence_created",
            routine_id,
            {
                "occurrenceId": occurrence_id,
                "scheduledFor": scheduled_for,
            },
        ),
        relay_task_event(
            "task.updated",
            routine_id,
            {
                "routineNextRunDate": next_run_date or "",
                "routineEnabled": bool(next_run_date),
            },
        ),
        relay_task_event(
            "task.activity",
            routine_id,
            {
                "activity": {
                    "id": new_relay_id("act"),
                    "createdAt": now_iso(),
                    "message": f"Routine occurrence created: {occurrence_id}.",
                    **({"agent": agent} if agent else {}),
                }
            },
        ),
    ]


def new_dispatch_claim(
    *, claim_id: str | None = None, lease_seconds: int = 60
) -> dict[str, str]:
    claimed_at = datetime.now(timezone.utc)
    return {
        "id": claim_id or new_relay_id("claim"),
        "claimedAt": claimed_at.isoformat().replace("+00:00", "Z"),
        "expiresAt": (claimed_at + timedelta(seconds=lease_seconds))
        .isoformat()
        .replace("+00:00", "Z"),
    }


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


def dispatch_claim_active(task: dict[str, Any]) -> bool:
    claim = task.get("dispatchClaim")
    if not isinstance(claim, dict):
        return False
    expires_at = _parse_iso(claim.get("expiresAt"))
    return bool(expires_at and expires_at > datetime.now(timezone.utc))


def dispatch_retry_due(task: dict[str, Any]) -> bool:
    retry = task.get("dispatchRetry")
    if not isinstance(retry, dict):
        return True
    deadline = _parse_iso(retry.get("nextAttemptAt"))
    return deadline is None or deadline <= datetime.now(timezone.utc)
