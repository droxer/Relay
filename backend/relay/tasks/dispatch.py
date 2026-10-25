from __future__ import annotations

from starlette.concurrency import run_in_threadpool

from typing import Any

from loguru import logger

from ..collaboration.assignments import assignment_team_snapshot
from ..collaboration.manifest import compile_assignment_work_graph, create_round_manifest
from ..core.ids import new_database_id
from ..core.models import AgentName
from ..persistence.protocols import TaskDispatchAssignment
from ..core.validation import valid_agent
from ..persistence.task.rules import dispatch_claim_active
from .placement import ensure_managed_capacity_for_task, ready_node_for_task, task_goal_text
from ..agents.routing import (
    AgentRoutingError,
    dispatch_failure_code,
    dispatch_reason_code,
    resolve_agent_assignments,
)
from .dispatch_failure import (
    record_dispatch_failure,
    safe_dispatch_error_message,
)
from .issue_triage import ISSUE_NEEDS_PROJECT, issue_needs_project
from ..projects.runtime import ProjectDispatchError, resolve_project_task_assignments
from .workspace import (
    recorded_task_workspace,
    resolve_task_workspace,
    task_workspace_nodes,
)
from ..teams.dispatch import (
    TEAM_UNAVAILABLE_MESSAGE,
    TeamDispatchError,
    resolve_team_task_assignments,
    task_execution_user_id,
)
from .dispatch_results import dispatch_result_scope
from .dispatch_outcome import (
    DispatchResult,
    TaskDispatchContext,
    _record_result,
    _result,
    _unclaimable_dispatch,
)
from ..security.actor import Actor

PERMANENT_DISPATCH_CODES = frozenset(
    {
        "agent_disabled",
        "agent_forbidden",
        "agent_not_found",
        "agent_policy_unsupported",
        "executor_mismatch",
    }
)


class TaskDispatcher:
    def __init__(
        self,
        ctx: TaskDispatchContext,
        task: dict[str, Any],
        actor: Actor,
        *,
        assignments: list[dict[str, Any]] | None,
        record_pending: bool,
        retry_blocked: bool = False,
    ) -> None:
        self.ctx = ctx
        self.task = task
        self.actor = actor
        self.run_assignments = assignments or []
        self.record_pending = record_pending
        self.retry_blocked = retry_blocked
        self.team_assignment_resolved = False
        self.project_assignment_resolved = False
        self.project_snapshot: dict[str, Any] | None = None
        self.team_snapshot: dict[str, Any] | None = None
        self.agent: AgentName | None = None
        self.agent_first = False
        self.temporary_group_status = False
        self.claim_id: str | None = None

    async def start(self) -> DispatchResult | None:
        node, result = await run_in_threadpool(self._prepare)
        if node is None:
            return result
        return await self._dispatch(node)

    def _prepare(self) -> tuple[dict[str, Any] | None, DispatchResult | None]:
        self._prepared_node: dict[str, Any] | None = None
        result = self._prepare_dispatch()
        return self._prepared_node, result

    def _prepare_dispatch(self) -> DispatchResult | None:
        # Work already under way reports that, not that it could never start.
        if issue_needs_project(self.task) and not self._execution_active():
            return _record_result(
                self.ctx,
                self.task["id"],
                "rejected",
                code=ISSUE_NEEDS_PROJECT,
                message="Move this task into a project before it can run.",
            )
        if (
            self.retry_blocked
            and self.task.get("status") == "blocked"
            and not self.task.get("isRoutine")
        ):
            # Only an explicit user start may reopen failed work. Serialize the
            # ownership check and status event with admission and other writes.
            with (
                self.ctx.registry.dispatch_lock,
                self.ctx.task_store.task_write_scope(self.task["id"]) as current,
            ):
                self.task = current
                if current.get("status") == "blocked":
                    if self._execution_active():
                        return self._active_result()
                    self.task = self.ctx.task_store.update_task_if_not_dispatching(
                        current["id"],
                        {
                            "status": "assigned",
                            "actorUserId": self.actor.get("userId"),
                            "expectedStatus": "blocked",
                            "expectedExecutionRevision": (current.get("executionOwner") or {}).get("revision", 0),
                        },
                    )
        if not self._dispatchable():
            return _record_result(
                self.ctx,
                self.task["id"],
                "rejected",
                code="invalid_state",
                message=f"A {self.task.get('status')} task cannot be started.",
            )
        # Queued executions remain assigned until the daemon starts. Do not
        # re-resolve (and potentially block) work that already has an owner.
        if self._execution_active():
            return self._active_result()
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
        self._prepared_node = node
        return None

    def _execution_active(self) -> bool:
        daemon_store = self.ctx.registry.daemon_store
        return bool(
            dispatch_claim_active(self.task)
            or daemon_store.active_run_request_for_task(self.task["id"])
            or any(
                daemon_store.active_run_request_for_session_any_node(session_id)
                for session_id in self.task.get("linkedSessionIds", [])
            )
        )

    def _active_result(self) -> DispatchResult:
        return _result(
            self.task,
            "queued",
            code="task_execution_active",
            message="This task already has a dispatch or execution in progress.",
        )

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
                    daemon_nodes=task_workspace_nodes(
                        self.task,
                        self.ctx.registry.monitor_nodes(),
                        self.ctx.session_store,
                    ),
                    session_store=self.ctx.session_store,
                    team_store=self.ctx.team_store,
                )
            )
            self.project_assignment_resolved = True
            return None
        except ProjectDispatchError as error:
            if not self.record_pending:
                raise
            message = f"The project cannot execute this task ({error.code})."
            if error.permanent:
                self.task = self.ctx.task_store.update_task(
                    self.task["id"],
                    {
                        "status": "blocked",
                        "blockerReason": message,
                        "attention": {"code": dispatch_reason_code(error.code), "source": "dispatch"},
                    },
                )
            else:
                self._mark_assigned_if_backlog()
            return _record_result(
                self.ctx,
                self.task["id"],
                "rejected" if error.permanent else "queued",
                code=error.code,
                message=message,
            )
        except AgentRoutingError as error:
            if not self.record_pending:
                raise
            if error.code not in PERMANENT_DISPATCH_CODES:
                self._mark_assigned_if_backlog()
            return self._routing_error_result(error)

    def _resolve_team_assignments(self) -> DispatchResult | None:
        # A project task's team was already resolved inside the project, pinned
        # to its computer and workspace; resolving it again would drop both.
        if not self.task.get("assignedTeamId") or self.project_assignment_resolved:
            return None
        try:
            self.run_assignments = resolve_team_task_assignments(
                self.task,
                team_store=self.ctx.team_store,
                agent_store=self.ctx.agent_store,
                placement_store=self.ctx.agent_placement_store,
                daemon_nodes=task_workspace_nodes(
                    self.task, self.ctx.registry.monitor_nodes(), self.ctx.session_store
                ),
                session_store=self.ctx.session_store,
            )
            self.team_assignment_resolved = True
            return None
        except TeamDispatchError as error:
            if not self.record_pending:
                raise
            self._mark_assigned_if_backlog()
            message = (
                f"The assigned team cannot execute this task ({error.code})."
                if error.permanent
                else TEAM_UNAVAILABLE_MESSAGE
            )
            if error.permanent:
                self.task = self.ctx.task_store.update_task(
                    self.task["id"],
                    {
                        "status": "blocked",
                        "blockerReason": message,
                        "attention": {"code": dispatch_reason_code(error.code), "source": "dispatch"},
                    },
                )
            return _record_result(
                self.ctx,
                self.task["id"],
                "rejected" if error.permanent else "queued",
                code=error.code,
                message=message,
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
                    user_id=task_execution_user_id(self.task)
                    or self.actor["userId"],
                    is_admin=False,
                    agent_store=self.ctx.agent_store,
                    placement_store=self.ctx.agent_placement_store,
                    daemon_nodes=task_workspace_nodes(
                        self.task,
                        self.ctx.registry.monitor_nodes(),
                        self.ctx.session_store,
                    ),
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
                self.task["id"],
                {
                    "status": "blocked",
                    "blockerReason": message,
                    "attention": {"code": dispatch_reason_code(error.code), "source": "dispatch"},
                },
            )
        if state == "queued":
            capacity = ensure_managed_capacity_for_task(
                self.task, self.ctx.registry, self.ctx.managed_node_store
            )
            if capacity and capacity.provisioning_requested:
                # Activity text is shown as-is, and a user id must never be
                # rendered as a name; the task already says whose work it is.
                message = "Managed node provisioning requested."
                self.ctx.task_store.record_activity(
                    self.task["id"], message, activity_payload
                )
        return _record_result(
            self.ctx, self.task["id"], state, code=code, message=message
        )

    def _node_unavailable_result(self) -> DispatchResult | None:
        capacity = ensure_managed_capacity_for_task(
            self.task, self.ctx.registry, self.ctx.managed_node_store
        )
        requested_capacity = bool(capacity and capacity.provisioning_requested)
        if not self.record_pending:
            return None
        label = ", ".join(dict.fromkeys(item["agent"] for item in self.run_assignments))
        message = (
            "Managed node provisioning requested."
            if requested_capacity
            else f"No ready node is available for {label}."
        )
        self.ctx.task_store.record_activity(
            self.task["id"],
            message,
            {"agent": self.agent},
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
            request = await run_in_threadpool(self._run_request, node)
            session = await self.ctx.backend.run(node["id"], request)
        except Exception as error:  # noqa: BLE001 - converted to a recorded dispatch failure, never swallowed
            return await run_in_threadpool(self._finish_dispatch, node, None, error)
        return await run_in_threadpool(self._finish_dispatch, node, session, None)

    def _finish_dispatch(self, node: dict[str, Any], session: dict[str, Any] | None,
                         error: Exception | None) -> DispatchResult:
        with dispatch_result_scope(self.ctx.task_store, self.task, self.claim_id, success=error is None) as current:
            if current is None:
                return _result(self.ctx.task_store.get_task(self.task["id"]),
                               "queued" if error else "started", session=session,
                               **({"code": "dispatch_superseded"} if error else {}))
            self.task = current
            if error is not None:
                return self._dispatch_error_result(error)
            if session is None:
                # Unreachable: a run that raised nothing returned its session.
                # Same failure as indexing the missing session would raise.
                raise TypeError("A dispatched run returned no session.")
            return self._record_dispatch_started(session, node)

    def _record_dispatch_started(self, session: dict[str, Any], node: dict[str, Any]) -> DispatchResult:
        self.ctx.task_store.clear_dispatch_retry(self.task["id"])
        if self.claim_id:
            self.ctx.task_store.release_dispatch_claim(self.task["id"], self.claim_id)
        message = f"Dispatched to {self.agent}; waiting for agent execution."
        self.ctx.task_store.record_activity(
            self.task["id"],
            message,
            {"agent": self.agent, "sessionId": session["id"]},
        )
        logger.info(
            "Task dispatched",
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
        # A project thread belongs to its project room; the team only chose who
        # runs this task, so it never becomes the thread's team.
        if self.task.get("assignedTeamId") and not self.project_snapshot:
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
            session_store=self.ctx.session_store,
        )
        binding = recorded_task_workspace(
            self.task, self.ctx.session_store, self.ctx.registry.monitor_nodes()
        )
        if binding and layout in ("thread", "node-root"):
            request["sessionId"] = binding["sessionId"]
        request["workspaceLayout"] = layout
        if subpath:
            request["workspaceSubpath"] = subpath
        if self.project_snapshot:
            request["projectId"] = self.project_snapshot["projectId"]
        if self.claim_id:
            request["idempotencyKey"] = self.claim_id
        if not self.actor["isAdmin"]:
            request["actorUserId"] = self.actor["userId"]
        return request

    def _dispatch_error_result(self, error: Exception) -> DispatchResult:
        code = dispatch_failure_code(error)
        released = bool(self.claim_id and code != "dispatch_failed")
        if released and self.claim_id:
            self.ctx.task_store.release_dispatch_claim(self.task["id"], self.claim_id)
        if self.temporary_group_status and released:
            self.ctx.task_store.update_task(self.task["id"], {"status": "backlog"})
        if not self.record_pending:
            # Explicit, not a bare `raise`: this runs in a threadpool worker,
            # where no exception is being handled.
            raise error
        updated = record_dispatch_failure(
            self.ctx.task_store, self.task, code=code,
            message=safe_dispatch_error_message(error),
        )
        return _result(
            updated, "rejected", code=code,
            message=updated["dispatchOutcome"]["message"],
        )

    def _mark_assigned_if_backlog(self) -> None:
        if self.task.get("status") == "backlog":
            self.task = self.ctx.task_store.update_task(
                self.task["id"], {"status": "assigned"}
            )


async def start_task_on_ready_node(
    ctx: TaskDispatchContext,
    task: dict[str, Any],
    actor: Actor,
    *,
    assignments: list[dict[str, Any]] | None = None,
    record_pending: bool = True,
    retry_blocked: bool = False,
) -> DispatchResult | None:
    return await TaskDispatcher(
        ctx,
        task,
        actor,
        assignments=assignments,
        record_pending=record_pending,
        retry_blocked=retry_blocked,
    ).start()
