from __future__ import annotations

from datetime import date
from typing import Any, Protocol, TypedDict

from loguru import logger

from ..collaboration.service import (
    assignment_team_snapshot,
    compile_assignment_work_graph,
    create_round_manifest,
)
from ..core.ids import new_database_id
from ..daemon_registry import DaemonNodeRegistry, ServerDaemonNodeBackend
from ..persistence.protocols import (
    AgentPlacementStore,
    AgentStore,
    ManagedNodeStore,
    ProjectStore,
    SessionStore,
    TaskDispatchAssignment,
    TaskStore,
    TeamStore,
)
from ..persistence.stores import valid_agent
from ..tasks import (
    ensure_managed_capacity_for_task,
    next_routine_date,
    ready_node_for_task,
    task_goal_text,
)
from .agent_routing import (
    AgentRoutingError,
    dispatch_failure_code,
    dispatch_reason_code,
    resolve_agent_assignments,
)
from .dispatch_retry import (
    DISPATCH_RETRY_EXHAUSTED_CODE,
    record_dispatch_retry,
    safe_dispatch_error_message,
)
from .project_runtime import ProjectDispatchError, resolve_project_task_assignments
from .task_workspace import resolve_task_workspace
from .team_dispatch import (
    TEAM_UNAVAILABLE_MESSAGE,
    TeamDispatchError,
    resolve_team_task_assignments,
    task_execution_employee_id,
)

PERMANENT_DISPATCH_CODES = frozenset(
    {
        "agent_disabled",
        "agent_forbidden",
        "agent_not_found",
        "agent_policy_unsupported",
        "executor_mismatch",
    }
)


class DispatchInfo(TypedDict, total=False):
    state: str
    code: str
    message: str


class DispatchResult(TypedDict):
    task: dict[str, Any]
    session: dict[str, Any] | None
    dispatch: DispatchInfo


class TaskDispatchContext(Protocol):
    task_store: TaskStore
    session_store: SessionStore
    agent_store: AgentStore
    agent_placement_store: AgentPlacementStore
    team_store: TeamStore
    project_store: ProjectStore
    managed_node_store: ManagedNodeStore
    registry: DaemonNodeRegistry
    backend: ServerDaemonNodeBackend


def implicit_group_assignments_for_task(
    ctx: TaskDispatchContext,
    task: dict[str, Any],
) -> list[dict[str, Any]]:
    """Build the legacy unclassified-task roster from ready named agents.

    Historical tasks predate explicit project/team/agent assignments. Keep
    those rows runnable, but only through agents that already exist and can be
    resolved on the task owner's Computers; daemon registration must not
    manufacture compatibility agents.
    """
    employee_id = task.get("assigneeEmployeeId") or task.get("ownerEmployeeId")
    if not employee_id:
        return []

    selected: list[dict[str, Any]] = []
    daemon_nodes = ctx.registry.monitor_nodes()
    for logical_agent in ctx.agent_store.list_agents(
        supervisor_employee_id=employee_id
    ):
        if not logical_agent.get("enabled", True):
            continue
        candidate: dict[str, Any] = {
            "agentId": logical_agent["id"],
            "agent": logical_agent["executorKind"],
        }
        if logical_agent.get("defaultRole"):
            candidate["role"] = logical_agent["defaultRole"]
        try:
            resolve_agent_assignments(
                [*selected, candidate],
                employee_id=employee_id,
                is_admin=True,
                agent_store=ctx.agent_store,
                placement_store=ctx.agent_placement_store,
                daemon_nodes=daemon_nodes,
            )
        except AgentRoutingError:
            continue
        selected.append(candidate)
    return selected


def _result(
    task: dict[str, Any],
    state: str,
    *,
    session: dict[str, Any] | None = None,
    code: str | None = None,
    message: str | None = None,
) -> DispatchResult:
    dispatch: DispatchInfo = {"state": state}
    if code:
        dispatch["code"] = code
    if message:
        dispatch["message"] = message
    return {"task": task, "session": session, "dispatch": dispatch}


def _record_result(
    ctx: TaskDispatchContext,
    task_id: str,
    state: str,
    *,
    code: str | None = None,
    message: str | None = None,
) -> DispatchResult:
    task = ctx.task_store.record_dispatch_outcome(
        task_id, state, code=code, message=message
    )
    return _result(task, state, code=code, message=message)


def _unclaimable_dispatch(task: dict[str, Any], agent: str | None) -> DispatchInfo:
    """Explain why a task could not be claimed for dispatch.

    A held claim does not prove work is under way. An unclassified failure
    keeps its claim on purpose, so a partially started run is never dispatched
    twice — which means the operator is told "in progress" about a dispatch
    that already failed and created no thread. Surface the recorded outcome
    instead, and name the other refusals rather than folding them in too.
    """
    if task.get("isRoutine"):
        return {
            "state": "queued",
            "code": "routine_not_dispatchable",
            "message": "Routines are dispatched by their schedule, not directly.",
        }
    assigned_agent = task.get("assignedAgent")
    if agent and assigned_agent and assigned_agent != agent:
        return {
            "state": "queued",
            "code": "agent_mismatch",
            "message": f"This task is assigned to {assigned_agent}, not {agent}.",
        }
    if task.get("status") != "assigned":
        return {
            "state": "queued",
            "code": "task_not_assigned",
            "message": f"A {task.get('status')} task cannot be dispatched.",
        }
    outcome = task.get("dispatchOutcome") or {}
    code = outcome.get("code")
    if outcome.get("state") == "queued" and code:
        return {
            "state": "queued",
            "code": code,
            "message": (
                "The last dispatch attempt failed and no thread was created: "
                f"{outcome.get('message') or code}"
            ),
        }
    return {
        "state": "queued",
        "code": "dispatch_in_progress",
        "message": "This task already has a dispatch in progress.",
    }


class TaskDispatcher:
    def __init__(
        self,
        ctx: TaskDispatchContext,
        task: dict[str, Any],
        actor: dict[str, Any],
        *,
        assignments: list[dict[str, Any]] | None,
        record_pending: bool,
    ) -> None:
        self.ctx = ctx
        self.task = task
        self.actor = actor
        self.run_assignments = assignments or []
        self.record_pending = record_pending
        self.team_assignment_resolved = False
        self.project_assignment_resolved = False
        self.project_snapshot: dict[str, Any] | None = None
        self.team_snapshot: dict[str, Any] | None = None
        self.agent: str | None = None
        self.agent_first = False
        self.temporary_group_status = False
        self.claim_id: str | None = None

    async def start(self) -> DispatchResult | None:
        if not self._dispatchable():
            return _record_result(
                self.ctx,
                self.task["id"],
                "rejected",
                code="invalid_state",
                message=f"A {self.task.get('status')} task cannot be started.",
            )
        project_result = self._resolve_project_assignments()
        if project_result:
            return project_result
        team_result = self._resolve_team_assignments()
        if team_result:
            return team_result
        if not self._prepare_assignments():
            return None

        node, dispatch_result = self._resolve_node()
        if dispatch_result:
            return dispatch_result
        if node is None:
            return self._node_unavailable_result()

        claim_result = self._claim_task()
        if claim_result:
            return claim_result
        return await self._dispatch(node)

    def _dispatchable(self) -> bool:
        """Refuse a task that is not waiting to run, before anything mutates it.

        Team resolution blocks the task when the team is gone or disabled, and
        promotes a backlog task to assigned. Both are wrong for a task that is
        already running or finished, so the status guard has to come first —
        it used to live inside assignment preparation, which runs after.
        """
        return not self.task.get("isRoutine") and self.task.get("status") in (
            "backlog",
            "assigned",
        )

    def _resolve_project_assignments(self) -> DispatchResult | None:
        if not self.task.get("projectId"):
            return None
        try:
            self.run_assignments, self.project_snapshot = (
                resolve_project_task_assignments(
                    self.task,
                    project_store=self.ctx.project_store,
                    agent_store=self.ctx.agent_store,
                    placement_store=self.ctx.agent_placement_store,
                    daemon_nodes=self.ctx.registry.monitor_nodes(),
                    session_store=self.ctx.session_store,
                )
            )
            self.project_assignment_resolved = True
            return None
        except ProjectDispatchError as error:
            if not self.record_pending:
                raise
            if error.permanent:
                self.task = self.ctx.task_store.update_task(
                    self.task["id"], {"status": "blocked"}
                )
            return _record_result(
                self.ctx,
                self.task["id"],
                "rejected" if error.permanent else "queued",
                code=error.code,
                message=f"The project cannot execute this task ({error.code}).",
            )
        except AgentRoutingError as error:
            if not self.record_pending:
                raise
            return self._routing_error_result(error)

    def _resolve_team_assignments(self) -> DispatchResult | None:
        if not self.task.get("assignedTeamId"):
            return None
        try:
            self.run_assignments = resolve_team_task_assignments(
                self.task,
                team_store=self.ctx.team_store,
                agent_store=self.ctx.agent_store,
                placement_store=self.ctx.agent_placement_store,
                daemon_nodes=self.ctx.registry.monitor_nodes(),
                session_store=self.ctx.session_store,
            )
            self.team_assignment_resolved = True
            return None
        except TeamDispatchError as error:
            if not self.record_pending:
                raise
            self._mark_assigned_if_backlog()
            if error.permanent:
                self.task = self.ctx.task_store.update_task(
                    self.task["id"], {"status": "blocked"}
                )
            return _record_result(
                self.ctx,
                self.task["id"],
                "rejected" if error.permanent else "queued",
                code=error.code,
                message=(
                    f"The assigned team cannot execute this task ({error.code})."
                    if error.permanent
                    else TEAM_UNAVAILABLE_MESSAGE
                ),
            )
        except AgentRoutingError as error:
            if not self.record_pending:
                raise
            self._mark_assigned_if_backlog()
            return self._routing_error_result(error)

    def _prepare_assignments(self) -> bool:
        self.agent = valid_agent(self.task.get("assignedAgent")) or (
            self.run_assignments[0]["agent"] if self.run_assignments else None
        )
        if not self.agent:
            return False
        if not self.run_assignments:
            self.run_assignments = [
                {
                    "agent": self.agent,
                    **(
                        {"agentId": self.task["assignedAgentId"]}
                        if self.task.get("assignedAgentId")
                        else {}
                    ),
                }
            ]
        self.run_assignments = [
            {
                **assignment,
                "assignmentId": assignment.get("assignmentId") or new_database_id(),
            }
            for assignment in self.run_assignments
        ]
        # compile_assignment_work_graph preserves the snapshot key on each
        # assignment, so the manifest in _run_request reuses this capture.
        self.team_snapshot = assignment_team_snapshot(self.run_assignments)
        self.run_assignments = compile_assignment_work_graph(
            self.run_assignments,
            purpose="accomplish",
            team_snapshot=self.team_snapshot,
        )
        if (
            self.task.get("assignedAgentId") or self.task.get("assignedTeamId")
        ) and self.task.get("status") == "backlog":
            self._mark_assigned_if_backlog()
        self.agent_first = any(item.get("agentId") for item in self.run_assignments)
        return True

    def _resolve_node(
        self,
    ) -> tuple[dict[str, Any] | None, DispatchResult | None]:
        if self.team_assignment_resolved or self.project_assignment_resolved:
            # Team assignments are already bound to the placements' node. Scanning
            # for a ready node again can hand back a different computer than the
            # one the commands go to, pinning the thread to the wrong workspace.
            return (
                self.ctx.registry.get(self.run_assignments[0]["daemonNodeId"]),
                None,
            )
        if self.agent_first:
            try:
                self.run_assignments = resolve_agent_assignments(
                    self.run_assignments,
                    employee_id=task_execution_employee_id(self.task)
                    or self.actor["employeeId"],
                    is_admin=False,
                    agent_store=self.ctx.agent_store,
                    placement_store=self.ctx.agent_placement_store,
                    daemon_nodes=self.ctx.registry.monitor_nodes(),
                    session_store=self.ctx.session_store,
                )
            except AgentRoutingError as error:
                if not self.record_pending:
                    raise
                return None, self._routing_error_result(
                    error,
                    activity_payload={"agent": self.agent},
                )
            return (
                self.ctx.registry.get(self.run_assignments[0]["daemonNodeId"]),
                None,
            )
        return (
            ready_node_for_task(self.ctx.registry, self.task, self.run_assignments),
            None,
        )

    def _routing_error_result(
        self,
        error: AgentRoutingError,
        *,
        activity_payload: dict[str, Any] | None = None,
    ) -> DispatchResult:
        code = dispatch_reason_code(error.code)
        state = "rejected" if error.code in PERMANENT_DISPATCH_CODES else "queued"
        message = str(error)
        if state == "rejected":
            self.task = self.ctx.task_store.update_task(
                self.task["id"], {"status": "blocked"}
            )
        if state == "queued":
            capacity = ensure_managed_capacity_for_task(
                self.task, self.ctx.registry, self.ctx.managed_node_store
            )
            if capacity and capacity.provisioning_requested:
                employee_id = task_execution_employee_id(self.task)
                message = f"Managed node provisioning requested for {employee_id}."
                self.ctx.task_store.record_activity(
                    self.task["id"], message, activity_payload
                )
        return _record_result(
            self.ctx, self.task["id"], state, code=code, message=message
        )

    def _node_unavailable_result(self) -> DispatchResult | None:
        employee_id = self.task.get("assigneeEmployeeId") or self.task.get(
            "ownerEmployeeId"
        )
        capacity = ensure_managed_capacity_for_task(
            self.task, self.ctx.registry, self.ctx.managed_node_store
        )
        requested_capacity = bool(capacity and capacity.provisioning_requested)
        if not self.record_pending:
            return None
        label = ", ".join(dict.fromkeys(item["agent"] for item in self.run_assignments))
        message = (
            f"Managed node provisioning requested for {employee_id}."
            if requested_capacity
            else f"No ready node is available for {label}."
        )
        self.ctx.task_store.record_activity(
            self.task["id"], message, {"agent": self.agent}
        )
        code = "configuration_pending" if requested_capacity else "agent_offline"
        return _record_result(
            self.ctx, self.task["id"], "queued", code=code, message=message
        )

    def _claim_task(self) -> DispatchResult | None:
        if self.task.get("status") == "backlog":
            self._mark_assigned_if_backlog()
            self.temporary_group_status = not bool(
                self.task.get("assignedAgentId") or self.task.get("assignedTeamId")
            )
        claim_agent = valid_agent(self.task.get("assignedAgent")) or self.agent
        if not claim_agent:
            return None
        claimed = self.ctx.task_store.claim_task_for_dispatch(
            self.task["id"],
            claim_agent,
            message=f"Claimed by {self.agent}.",
            expected_assignment=TaskDispatchAssignment.capture(self.task),
        )
        if not claimed:
            current = self.ctx.task_store.get_task(self.task["id"])
            refusal = _unclaimable_dispatch(current, claim_agent)
            return _result(
                current,
                refusal["state"],
                code=refusal.get("code"),
                message=refusal.get("message"),
            )
        self.task = claimed
        self.claim_id = (self.task.get("dispatchClaim") or {}).get("id")
        return None

    async def _dispatch(self, node: dict[str, Any]) -> DispatchResult:
        try:
            session = await self.ctx.backend.run(node["id"], self._run_request(node))
        except Exception as error:
            return self._dispatch_error_result(error)

        self.ctx.task_store.update_task(self.task["id"], {"status": "running"})
        self.ctx.task_store.clear_dispatch_retry(self.task["id"])
        if self.claim_id:
            self.ctx.task_store.release_dispatch_claim(self.task["id"], self.claim_id)
        message = f"{self.agent} started the task."
        self.ctx.task_store.record_activity(
            self.task["id"],
            message,
            {"agent": self.agent, "sessionId": session["id"]},
        )
        logger.info(
            "Task started",
            task_id=self.task["id"],
            session_id=session["id"],
            agent=self.agent,
            assignments=self.run_assignments,
            node_id=node["id"],
        )
        updated = self.ctx.task_store.record_dispatch_outcome(
            self.task["id"], "started"
        )
        return _result(updated, "started", session=session)

    def _run_request(self, node: dict[str, Any]) -> dict[str, Any]:
        request: dict[str, Any] = {
            "taskGoal": task_goal_text(self.task),
            "assignments": self.run_assignments,
            "taskId": self.task["id"],
            "actorIsAdmin": self.actor["isAdmin"],
            "collaboration": {
                "manifest": create_round_manifest(
                    source="task",
                    purpose="accomplish",
                    address=(
                        {"kind": "room"}
                        if self.task.get("assignedTeamId")
                        else {
                            "kind": "members",
                            "agentIds": [
                                assignment["agentId"]
                                for assignment in self.run_assignments
                                if assignment.get("agentId")
                            ],
                        }
                    ),
                    assignments=self.run_assignments,
                    team_snapshot=self.team_snapshot,
                    project_snapshot=self.project_snapshot,
                )
            },
        }
        if self.agent_first:
            request["agentFirst"] = True
        if self.task.get("assignedTeamId"):
            request["teamId"] = self.task["assignedTeamId"]
        # Resolved against the node `_dispatch` already holds, not
        # re-derived from run_assignments[0]["daemonNodeId"]: the legacy
        # no-agent-record branch (ready_node_for_task, see _resolve_node)
        # finds a node without ever writing a daemonNodeId onto the
        # assignment, so re-deriving it here would KeyError.
        layout, subpath = resolve_task_workspace(
            self.task,
            node=node,
            project_snapshot=self.project_snapshot,
        )
        request["workspaceLayout"] = layout
        if subpath:
            request["workspaceSubpath"] = subpath
        if self.project_snapshot:
            request["projectId"] = self.project_snapshot["projectId"]
        if self.claim_id:
            request["idempotencyKey"] = self.claim_id
        if not self.actor["isAdmin"]:
            request["actorEmployeeId"] = self.actor["employeeId"]
        return request

    def _dispatch_error_result(self, error: Exception) -> DispatchResult:
        code = dispatch_failure_code(error)
        released = bool(self.claim_id and code != "dispatch_failed")
        if released and self.claim_id:
            self.ctx.task_store.release_dispatch_claim(self.task["id"], self.claim_id)
        if self.temporary_group_status and released:
            self.ctx.task_store.update_task(self.task["id"], {"status": "backlog"})
        if not self.record_pending:
            raise
        if code != "dispatch_failed":
            # A classified failure means the run was not accepted; record the
            # retry under the same rules the scheduler uses. An unclassified
            # failure keeps its claim because acceptance is ambiguous, and an
            # ambiguous acceptance must not consume retry budget.
            updated = record_dispatch_retry(
                self.ctx.task_store,
                self.task,
                code=code,
                message=safe_dispatch_error_message(error),
            )
            if updated.get("status") == "blocked":
                return _result(
                    updated,
                    "rejected",
                    code=DISPATCH_RETRY_EXHAUSTED_CODE,
                    message=(updated.get("dispatchOutcome") or {}).get("message"),
                )
        state = "rejected" if code == "agent_forbidden" else "queued"
        return _record_result(
            self.ctx,
            self.task["id"],
            state,
            code=code,
            message=str(error),
        )

    def _mark_assigned_if_backlog(self) -> None:
        if self.task.get("status") == "backlog":
            self.task = self.ctx.task_store.update_task(
                self.task["id"], {"status": "assigned"}
            )


async def start_task_on_ready_node(
    ctx: TaskDispatchContext,
    task: dict[str, Any],
    actor: dict[str, Any],
    *,
    assignments: list[dict[str, Any]] | None = None,
    record_pending: bool = True,
) -> DispatchResult | None:
    return await TaskDispatcher(
        ctx,
        task,
        actor,
        assignments=assignments,
        record_pending=record_pending,
    ).start()


async def start_routine_occurrence_on_ready_node(
    ctx: TaskDispatchContext,
    routine: dict[str, Any],
    actor: dict[str, Any],
    *,
    agent: str | None,
    run_date: date,
    assignments: list[dict[str, Any]] | None = None,
) -> DispatchResult | None:
    if not routine.get("isRoutine") or not routine.get("routineEnabled"):
        return None
    today = run_date
    today_iso = today.isoformat()
    scheduled_run_date = routine_next_run_date(routine)
    occurrence = active_routine_occurrence(ctx.task_store, routine)
    if not occurrence and scheduled_run_date and scheduled_run_date <= today:
        next_run = next_routine_date(
            scheduled_run_date, routine.get("routineCadence") or "weekly", today
        )
        occurrence = ctx.task_store.promote_due_routine(
            routine["id"],
            today_iso,
            next_run.isoformat() if next_run else None,
            agent_override=agent,
        )
        if not occurrence:
            refreshed = ctx.task_store.get_task(routine["id"])
            occurrence = active_routine_occurrence_for_date(
                ctx.task_store,
                refreshed,
                scheduled_run_date.isoformat(),
            )
            if not occurrence:
                return None
    elif not occurrence:
        occurrence = _create_manual_occurrence(ctx, routine, agent, today_iso)
        if not occurrence:
            return None
    if occurrence.get("status") in {"running", "review"}:
        existing = _existing_occurrence_result(ctx, routine, occurrence)
        if existing:
            return existing
        return _result(
            occurrence,
            "queued",
            code="already_active",
            message="The current routine occurrence is already active.",
        )
    # The occurrence is an immutable assignment snapshot. A routine may be
    # reassigned after promotion, but that must only affect later occurrences.
    result = await start_task_on_ready_node(ctx, occurrence, actor, assignments=None)
    if result and result.get("session"):
        ctx.task_store.link_session(routine["id"], result["session"]["id"])
    return result


def _create_manual_occurrence(
    ctx: TaskDispatchContext,
    routine: dict[str, Any],
    agent: str | None,
    scheduled_for: str,
) -> dict[str, Any] | None:
    return ctx.task_store.create_routine_occurrence(
        routine["id"],
        scheduled_for,
        agent_override=agent,
    )


def _existing_occurrence_result(
    ctx: TaskDispatchContext,
    routine: dict[str, Any],
    occurrence: dict[str, Any],
) -> DispatchResult | None:
    for session_id in reversed(occurrence.get("linkedSessionIds", [])):
        try:
            session = ctx.session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            continue
        if session_id not in routine.get("linkedSessionIds", []):
            ctx.task_store.link_session(routine["id"], session_id)
        return _result(occurrence, "started", session=session, code="already_started")
    return None


def active_routine_occurrence_for_date(
    task_store: TaskStore,
    routine: dict[str, Any],
    scheduled_for: str,
) -> dict[str, Any] | None:
    for event in reversed(routine.get("events", [])):
        if (
            event.get("type") != "task.occurrence_created"
            or event.get("scheduledFor") != scheduled_for
        ):
            continue
        occurrence_id = event.get("occurrenceId")
        if not isinstance(occurrence_id, str) or not occurrence_id:
            continue
        try:
            occurrence = task_store.get_task(occurrence_id)
        except (KeyError, FileNotFoundError):
            continue
        if occurrence.get("status") in {"backlog", "assigned", "running", "review"}:
            return occurrence
    return None


def active_routine_occurrence(
    task_store: TaskStore,
    routine: dict[str, Any],
) -> dict[str, Any] | None:
    for event in reversed(routine.get("events", [])):
        if event.get("type") != "task.occurrence_created":
            continue
        occurrence_id = event.get("occurrenceId")
        if not isinstance(occurrence_id, str) or not occurrence_id:
            continue
        try:
            occurrence = task_store.get_task(occurrence_id)
        except (KeyError, FileNotFoundError):
            continue
        if occurrence.get("status") in {"backlog", "assigned", "running", "review"}:
            return occurrence
    return None


def routine_next_run_date(routine: dict[str, Any]) -> date | None:
    next_run = routine.get("routineNextRunDate")
    if not next_run:
        return None
    try:
        return date.fromisoformat(next_run)
    except ValueError:
        return None
