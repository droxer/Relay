from __future__ import annotations

import asyncio
import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from loguru import logger

from ..collaboration.service import (
    assignment_team_snapshot,
    compile_assignment_work_graph,
    create_round_manifest,
)
from ..core.computer_identity import computer_id
from ..core.ids import new_database_id
from ..core.models import AgentName
from ..daemon_registry import node_accepts_run
from ..persistence.agent_placement_store import create_node_placement
from ..persistence.protocols import TaskDispatchAssignment
from ..persistence.stores import valid_agent
from ..persistence.task_store import (
    dispatch_retry_due,
    routine_due_sort_key,
    task_claim_sort_key,
)
from ..services.agent_routing import (
    AgentRoutingError,
    dispatch_failure_code,
    dispatch_reason_code,
    persist_legacy_session_computer_id,
    resolve_agent_assignments,
)
from ..services.dispatch_retry import (
    DEFAULT_MAX_CONSECUTIVE_DISPATCH_FAILURES,
    record_dispatch_retry,
    safe_dispatch_error_message,
)
from ..services.project_runtime import (
    ProjectDispatchError,
    resolve_project_task_assignments,
)
from ..services.task_rounds import (
    awaits_continuation,
    budget_exhausted_message,
    continuation_budget_exhausted,
    continuation_session_id,
)
from ..services.task_workspace import resolve_task_workspace
from ..services.team_dispatch import (
    TEAM_UNAVAILABLE_MESSAGE,
    TeamDispatchError,
    resolve_team_task_assignments,
    task_execution_employee_id,
)

PERMANENT_DISPATCH_CODES = {
    "agent_disabled",
    "agent_forbidden",
    "agent_not_found",
    "agent_policy_unsupported",
    "executor_mismatch",
}

ROUTINE_SKIP_NO_AGENT_MESSAGE = (
    "Routine skipped: no assigned agent. Assign an agent so the scheduler can run it."
)


def task_goal_text(task: dict[str, Any]) -> str:
    return (
        f"{task['title']}\n\n{task['description']}"
        if task.get("description")
        else task["title"]
    )


def materialize_legacy_agent_assignment(
    task: dict[str, Any],
    executor_kind: str,
    *,
    registry: Any,
    agent_store: Any,
    placement_store: Any,
) -> dict[str, Any] | None:
    employee_id = task_execution_employee_id(task)
    if not employee_id:
        return None
    assignment = {"agent": executor_kind}
    node = ready_node_for_task(registry, task, [assignment])
    if not node:
        return None
    node_computer_id = computer_id(node)
    candidates = sorted(
        (
            agent
            for agent in agent_store.list_agents(supervisor_employee_id=employee_id)
            if not agent.get("deletedAt")
            and agent.get("enabled", True)
            and agent["executorKind"] == executor_kind
            and agent.get("computerId") == node_computer_id
        ),
        key=lambda agent: (agent.get("createdAt") or "", agent["id"]),
    )
    if not candidates:
        logger.info(
            "No declared agent for this runtime; task stays queued",
            employee_id=employee_id,
            executor_kind=executor_kind,
            computer_id=node_computer_id,
        )
        return None
    agent = candidates[0]
    placement = next(
        (
            item
            for item in placement_store.list_placements(agent_id=agent["id"])
            if item.get("computerId") == node_computer_id
            or (not item.get("computerId") and item["daemonNodeId"] == node["id"])
        ),
        None,
    )
    if placement is None:
        create_node_placement(placement_store, agent, node)
    return {"agent": executor_kind, "agentId": agent["id"]}


def materialize_legacy_task_assignment(
    task: dict[str, Any],
    *,
    task_store: Any,
    registry: Any,
    agent_store: Any,
    placement_store: Any,
) -> dict[str, Any] | None:
    executor_kind = valid_agent(task.get("assignedAgent"))
    if not executor_kind or task.get("assignedAgentId"):
        return None
    assignment = materialize_legacy_agent_assignment(
        task,
        executor_kind,
        registry=registry,
        agent_store=agent_store,
        placement_store=placement_store,
    )
    if not assignment:
        return None
    return task_store.set_task_assignment(
        task["id"], executor_kind, assignment["agentId"]
    )


@dataclass(frozen=True)
class SchedulerTickResult:
    promoted: int = 0
    dispatched: int = 0
    skipped: int = 0


class TaskScheduler:
    def __init__(
        self,
        *,
        task_store: Any,
        registry: Any,
        backend: Any,
        team_store: Any | None = None,
        project_store: Any | None = None,
        managed_node_store: Any | None = None,
        org_settings_store: Any | None = None,
        interval_seconds: float = 10.0,
        max_dispatches_per_tick: int = 5,
        max_dispatch_failures: int = DEFAULT_MAX_CONSECUTIVE_DISPATCH_FAILURES,
        jitter: Callable[[], float] = random.random,
        today: Callable[[], date] = date.today,
    ) -> None:
        self.task_store = task_store
        self.registry = registry
        self.backend = backend
        self.team_store = team_store
        self.project_store = project_store
        self.managed_node_store = managed_node_store
        self.org_settings_store = org_settings_store
        self.interval_seconds = interval_seconds
        self.max_dispatches_per_tick = max_dispatches_per_tick
        self.max_dispatch_failures = max_dispatch_failures
        self._jitter = jitter
        self._today = today
        self._loop_task: asyncio.Task[None] | None = None
        self._tick_lock = asyncio.Lock()

    def start(self) -> None:
        if self._loop_task and not self._loop_task.done():
            return
        self._loop_task = asyncio.create_task(
            self._run_loop(), name="relay-task-scheduler"
        )
        logger.info("Task scheduler started", interval_seconds=self.interval_seconds)

    async def stop(self) -> None:
        if not self._loop_task:
            return
        self._loop_task.cancel()
        try:
            await self._loop_task
        except asyncio.CancelledError:
            pass
        self._loop_task = None
        logger.info("Task scheduler stopped")

    async def tick(self) -> SchedulerTickResult:
        async with self._tick_lock:
            today = self._today()
            promoted, promote_skipped = self._promote_due_routines(today)
            dispatched, dispatch_skipped = await self._dispatch_assigned_tasks()
            return SchedulerTickResult(
                promoted=promoted,
                dispatched=dispatched,
                skipped=promote_skipped + dispatch_skipped,
            )

    async def _run_loop(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Task scheduler tick failed")
            await asyncio.sleep(self.interval_seconds)

    def _promote_due_routines(self, today: date) -> tuple[int, int]:
        promoted = 0
        skipped = 0
        for routine in self._due_routines(today):
            routine = self._materialize_legacy_assignment(routine) or routine
            agent = valid_agent(routine.get("assignedAgent"))
            if not (
                routine.get("projectId")
                or (agent and routine.get("assignedAgentId"))
                or routine.get("assignedTeamId")
            ):
                skipped += 1
                self._record_routine_skip(routine)
                continue
            run_date = (
                date.fromisoformat(routine["routineNextRunDate"])
                if routine.get("routineNextRunDate")
                else today
            )
            next_run = next_routine_date(
                run_date, routine.get("routineCadence") or "weekly", today
            )
            occurrence = self.task_store.promote_due_routine(
                routine["id"],
                today.isoformat(),
                next_run.isoformat() if next_run else None,
            )
            if occurrence:
                promoted += 1
        return promoted, skipped

    def _record_routine_skip(self, routine: dict[str, Any]) -> None:
        activities = routine.get("activity") or []
        if (
            activities
            and activities[-1].get("message") == ROUTINE_SKIP_NO_AGENT_MESSAGE
        ):
            return
        self.task_store.record_activity(routine["id"], ROUTINE_SKIP_NO_AGENT_MESSAGE)
        logger.warning("Due routine skipped: no assigned agent", task_id=routine["id"])

    async def _dispatch_assigned_tasks(self) -> tuple[int, int]:
        dispatched = 0
        dispatchable = [
            self._materialize_legacy_assignment(task) or task
            for task in self._dispatchable_tasks()
        ]
        legacy = [
            task
            for task in dispatchable
            if valid_agent(task.get("assignedAgent"))
            and not task.get("assignedAgentId")
            and not task.get("assignedTeamId")
        ]
        for task in legacy:
            self._record_dispatch_deferred(
                task,
                "agent_not_found",
                "Select a named agent before this task can be dispatched.",
            )
        skipped = len(legacy)
        attempts = 0
        candidates = [
            task
            for task in dispatchable
            if (valid_agent(task.get("assignedAgent")) and task.get("assignedAgentId"))
            or bool(task.get("assignedTeamId"))
            or bool(task.get("projectId"))
        ]
        for task in candidates:
            if attempts >= self.max_dispatches_per_tick:
                break
            if not dispatch_retry_due(task):
                skipped += 1
                continue
            if self._continuation_refused(task):
                skipped += 1
                continue
            team_id = task.get("assignedTeamId")
            project_snapshot: dict[str, Any] | None = None
            agent = valid_agent(task.get("assignedAgent"))
            assignments: list[dict[str, Any]]
            # A continuation resumes its own thread, so routing has to respect
            # that thread's workspace affinity rather than pick a node afresh.
            resume_session_id = (
                continuation_session_id(task) if awaits_continuation(task) else None
            )
            resume_session = (
                self._session_for_continuation(resume_session_id)
                if resume_session_id
                else None
            )
            try:
                employee_id = task_execution_employee_id(task)
                daemon_nodes = self.registry.monitor_nodes()
                if resume_session:
                    resume_session = persist_legacy_session_computer_id(
                        resume_session,
                        session_store=self.registry.store,
                        placement_store=self.backend.agent_placement_store,
                        nodes={node["id"]: node for node in daemon_nodes},
                        daemon_store=self.registry.daemon_store,
                    )
                if task.get("projectId"):
                    if self.project_store is None:
                        raise ProjectDispatchError("project_store_unavailable")
                    assignments, project_snapshot = resolve_project_task_assignments(
                        task,
                        project_store=self.project_store,
                        agent_store=self.backend.agent_store,
                        placement_store=self.backend.agent_placement_store,
                        daemon_nodes=daemon_nodes,
                        session_store=self.registry.store,
                    )
                    agent = assignments[0]["agent"]
                elif team_id:
                    assignments = resolve_team_task_assignments(
                        task,
                        team_store=self.team_store,
                        agent_store=self.backend.agent_store,
                        placement_store=self.backend.agent_placement_store,
                        daemon_nodes=daemon_nodes,
                        session_store=self.registry.store,
                    )
                    agent = assignments[0]["agent"]
                else:
                    assignments = [
                        {
                            "agent": agent,
                            "agentId": task["assignedAgentId"],
                        }
                    ]
                    assignments = resolve_agent_assignments(
                        assignments,
                        employee_id=employee_id,
                        is_admin=False,
                        agent_store=self.backend.agent_store,
                        placement_store=self.backend.agent_placement_store,
                        daemon_nodes=daemon_nodes,
                        session=resume_session,
                        daemon_store=self.registry.daemon_store,
                        session_store=self.registry.store,
                    )
                assignments = [
                    {
                        **assignment,
                        "assignmentId": assignment.get("assignmentId")
                        or new_database_id(),
                    }
                    for assignment in assignments
                ]
                assignments = compile_assignment_work_graph(
                    assignments,
                    purpose="accomplish",
                    team_snapshot=assignment_team_snapshot(assignments),
                )
                node = self.registry.get(assignments[0]["daemonNodeId"])
            except ProjectDispatchError as error:
                state = "rejected" if error.permanent else "queued"
                self._record_dispatch_deferred(
                    task,
                    error.code,
                    f"The project cannot execute this task ({error.code}).",
                    state=state,
                )
                if error.permanent:
                    self.task_store.update_task(task["id"], {"status": "blocked"})
                skipped += 1
                continue
            except TeamDispatchError as error:
                self._record_dispatch_deferred(
                    task,
                    error.code,
                    (
                        f"The assigned team cannot execute this task ({error.code})."
                        if error.permanent
                        else TEAM_UNAVAILABLE_MESSAGE
                    ),
                    state="rejected" if error.permanent else "queued",
                )
                if error.permanent:
                    self.task_store.update_task(task["id"], {"status": "blocked"})
                skipped += 1
                continue
            except AgentRoutingError as error:
                state = (
                    "rejected" if error.code in PERMANENT_DISPATCH_CODES else "queued"
                )
                self._record_dispatch_deferred(
                    task, dispatch_reason_code(error.code), str(error), state=state
                )
                if error.code in PERMANENT_DISPATCH_CODES:
                    self.task_store.update_task(task["id"], {"status": "blocked"})
                    skipped += 1
                    continue
                node = None
            if not node:
                self._ensure_managed_capacity(task)
                skipped += 1
                continue
            claimed = self.task_store.claim_task_for_dispatch(
                task["id"],
                agent,
                expected_assignment=TaskDispatchAssignment.capture(task),
            )
            if not claimed:
                skipped += 1
                continue
            attempts += 1
            if await self._dispatch_claimed_task(
                claimed,
                agent,
                node["id"],
                assignments,
                team_id=team_id,
                project_snapshot=project_snapshot,
                session_id=resume_session_id,
            ):
                dispatched += 1
        return dispatched, skipped

    def _session_for_continuation(self, session_id: str) -> dict[str, Any] | None:
        store = getattr(self.backend, "registry", None)
        store = getattr(store, "store", None)
        if store is None:
            return None
        try:
            return store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            return None

    def _continuation_refused(self, task: dict[str, Any]) -> bool:
        """Stop a task that keeps asking for another round. True if refused.

        This is the only bound on automatic continuation: an agent that always
        reports "continue" would otherwise re-dispatch itself indefinitely. A
        refused task waits for a person rather than failing — the work so far
        is intact, and continuing it is a judgement call.
        """
        if not awaits_continuation(task):
            return False
        if not continuation_session_id(task):
            # Nothing to resume into: a fresh thread would start without the
            # work already done, so a human has to decide what happens next.
            self._park_for_human(
                task,
                "round_continuation_unavailable",
                "The round asked to continue, but its thread is no longer known.",
            )
            return True
        if continuation_budget_exhausted(task, self.org_settings_store):
            self._park_for_human(
                task,
                "round_budget_exhausted",
                budget_exhausted_message(task, self.org_settings_store),
            )
            return True
        return False

    def _park_for_human(self, task: dict[str, Any], code: str, message: str) -> None:
        self.task_store.record_round(task["id"], clear_continuation=True)
        self.task_store.update_task(task["id"], {"status": "waiting_for_human"})
        self._record_dispatch_deferred(task, code, message, state="rejected")
        self.task_store.record_activity(task["id"], message)
        logger.info("Task continuation refused", task_id=task["id"], code=code)

    def _materialize_legacy_assignment(
        self, task: dict[str, Any]
    ) -> dict[str, Any] | None:
        return materialize_legacy_task_assignment(
            task,
            task_store=self.task_store,
            registry=self.registry,
            agent_store=self.backend.agent_store,
            placement_store=self.backend.agent_placement_store,
        )

    def _record_dispatch_deferred(
        self,
        task: dict[str, Any],
        code: str,
        message: str,
        *,
        state: str = "queued",
    ) -> None:
        current = task.get("dispatchOutcome") or {}
        if current.get("state") == state and current.get("code") == code:
            return
        self.task_store.record_dispatch_outcome(
            task["id"], state, code=code, message=message
        )

    def _ensure_managed_capacity(self, task: dict[str, Any]) -> None:
        capacity = ensure_managed_capacity_for_task(
            task, self.registry, self.managed_node_store
        )
        if capacity and capacity.provisioning_requested:
            logger.info(
                "Managed node provisioning requested for queued task",
                task_id=task["id"],
                employee_id=(
                    task.get("assigneeEmployeeId") or task.get("ownerEmployeeId")
                ),
            )

    async def _dispatch_claimed_task(
        self,
        task: dict[str, Any],
        agent: AgentName,
        node_id: str,
        assignments: list[dict[str, Any]],
        *,
        team_id: str | None = None,
        project_snapshot: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> bool:
        claim = task.get("dispatchClaim") or {}
        claim_id = claim.get("id")
        try:
            collaboration = {
                "manifest": create_round_manifest(
                    source="task",
                    purpose="accomplish",
                    address=(
                        {"kind": "room"}
                        if team_id
                        else {
                            "kind": "members",
                            "agentIds": [
                                assignment["agentId"]
                                for assignment in assignments
                                if assignment.get("agentId")
                            ],
                        }
                    ),
                    assignments=assignments,
                    team_snapshot=assignment_team_snapshot(assignments),
                    project_snapshot=project_snapshot,
                )
            }
            layout, subpath = resolve_task_workspace(
                task,
                node=self.registry.get(node_id),
                project_snapshot=project_snapshot,
            )
            workspace_fields: dict[str, Any] = {"workspaceLayout": layout}
            if subpath:
                workspace_fields["workspaceSubpath"] = subpath
            if project_snapshot:
                workspace_fields["projectId"] = project_snapshot["projectId"]
            session = await self.backend.run(
                node_id,
                {
                    "taskGoal": task_goal_text(task),
                    "assignments": assignments,
                    "taskId": task["id"],
                    "actorIsAdmin": True,
                    "agentFirst": True,
                    **({"teamId": team_id} if team_id else {}),
                    **workspace_fields,
                    "collaboration": collaboration,
                    **({"sessionId": session_id} if session_id else {}),
                    **({"idempotencyKey": claim_id} if claim_id else {}),
                },
            )
        except Exception as error:
            code = dispatch_failure_code(error)
            if claim_id and code != "dispatch_failed":
                self.task_store.release_dispatch_claim(task["id"], claim_id)
            self.task_store.record_dispatch_outcome(
                task["id"],
                "queued",
                code=code,
                message=str(error),
            )
            if code != "dispatch_failed":
                # A classified failure means the run was not accepted, so the
                # retry budget applies. An unclassified ("dispatch_failed")
                # failure keeps its claim because the run may have been
                # accepted; that ambiguity must be reconciled by the claim
                # lease, not by consuming retry budget.
                record_dispatch_retry(
                    self.task_store,
                    task,
                    code=code,
                    message=safe_dispatch_error_message(error),
                    base_seconds=self.interval_seconds,
                    max_failures=self.max_dispatch_failures,
                    sample=self._jitter,
                )
            logger.warning(
                "Scheduled task dispatch failed",
                task_id=task["id"],
                agent=agent,
                error=str(error),
            )
            return False
        self.task_store.update_task(task["id"], {"status": "running"})
        self.task_store.clear_dispatch_retry(task["id"])
        if claim_id:
            self.task_store.release_dispatch_claim(task["id"], claim_id)
        self.task_store.record_dispatch_outcome(task["id"], "started")
        self.task_store.record_activity(
            task["id"],
            f"Scheduled dispatch started by {agent}.",
            {"agent": agent, "sessionId": session["id"]},
        )
        logger.info(
            "Scheduled task dispatched",
            task_id=task["id"],
            session_id=session["id"],
            agent=agent,
            node_id=node_id,
        )
        return True

    def _routine_due(self, task: dict[str, Any], today: date) -> bool:
        if (
            not task.get("isRoutine")
            or not task.get("routineEnabled")
            or not task.get("routineNextRunDate")
        ):
            return False
        try:
            next_run = date.fromisoformat(task["routineNextRunDate"])
        except ValueError:
            return False
        return next_run <= today

    def _due_routines(self, today: date) -> list[dict[str, Any]]:
        if hasattr(self.task_store, "list_due_routines"):
            return list(self.task_store.list_due_routines(today.isoformat()))
        routines = [
            task
            for task in self.task_store.list_tasks()
            if self._routine_due(task, today)
        ]
        return sorted(routines, key=routine_due_sort_key)

    def _dispatchable_tasks(self) -> list[dict[str, Any]]:
        if hasattr(self.task_store, "list_dispatchable_tasks"):
            return list(self.task_store.list_dispatchable_tasks())
        tasks = [
            task
            for task in self.task_store.list_tasks()
            if task.get("status") == "assigned"
            and not task.get("isRoutine")
            and (
                task.get("assignedAgent")
                or task.get("assignedTeamId")
                or task.get("projectId")
            )
        ]
        return sorted(tasks, key=task_claim_sort_key)


def ready_node_for_task(
    registry: Any, task: dict[str, Any], assignments: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if not assignments:
        return None
    requested_agents = [
        assignment.get("agent") for assignment in assignments if assignment.get("agent")
    ]
    employee_id = task.get("assigneeEmployeeId") or task.get("ownerEmployeeId")
    active_runs_by_node: dict[str, list[dict[str, Any]]] = {}
    for run in registry.daemon_store.list_active_runs():
        active_runs_by_node.setdefault(run["nodeId"], []).append(run)
    for node in registry.list_ready():
        if employee_id and node.get("employeeId") != employee_id:
            continue
        if node.get("status") in (
            "stopped",
            "failed",
            "provisioning",
        ) or not registry.is_live(node["id"]):
            continue
        disabled = set(node.get("disabledAgents") or [])
        if any(agent in disabled for agent in requested_agents):
            continue
        active_runs = active_runs_by_node.get(node["id"], [])
        if all(
            node.get("agents", {}).get(agent) == "ready" for agent in requested_agents
        ) and node_accepts_run(
            node,
            active_runs=active_runs,
        ):
            return node
    return None


def employee_has_device_node(registry: Any, employee_id: str) -> bool:
    return any(
        node.get("employeeId") == employee_id
        and node.get("nodeLocation") == "employee-device"
        and not node.get("retiredAt")
        for node in registry.monitor_nodes()
    )


def ensure_managed_capacity_for_task(
    task: dict[str, Any], registry: Any, managed_node_store: Any | None
) -> Any | None:
    if not managed_node_store:
        return None
    employee_id = task.get("assigneeEmployeeId") or task.get("ownerEmployeeId")
    if not employee_id or employee_has_device_node(registry, employee_id):
        return None
    return managed_node_store.ensure_node_for_employee(employee_id)


def next_routine_date(run_date: date, cadence: str, today: date) -> date | None:
    if cadence == "custom":
        return None
    next_run = _add_interval(run_date, cadence)
    while next_run <= today:
        next_run = _add_interval(next_run, cadence)
    return next_run


def _add_interval(value: date, cadence: str) -> date:
    if cadence == "daily":
        return value + timedelta(days=1)
    if cadence == "monthly":
        return _add_month(value)
    return value + timedelta(days=7)


def _add_month(value: date) -> date:
    month = value.month + 1
    year = value.year
    if month == 13:
        month = 1
        year += 1
    day = min(value.day, _month_days(year, month))
    return date(year, month, day)


def _month_days(year: int, month: int) -> int:
    if month == 12:
        following = date(year + 1, 1, 1)
    else:
        following = date(year, month + 1, 1)
    return (following - timedelta(days=1)).day
