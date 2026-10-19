"""What a dispatch attempt reports: its result shape and recorded outcome."""
from __future__ import annotations

from typing import Any, Protocol, TypedDict

from ..daemon_registry.registry import DaemonNodeRegistry
from ..daemon_registry.node_backend import ServerDaemonNodeBackend
from ..persistence.protocols import (
    AgentPlacementStore,
    AgentStore,
    ManagedNodeStore,
    ProjectStore,
    SessionStore,
    TaskStore,
    TeamStore,
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
    @property
    def task_store(self) -> TaskStore: ...
    @property
    def session_store(self) -> SessionStore: ...
    @property
    def agent_store(self) -> AgentStore: ...
    @property
    def agent_placement_store(self) -> AgentPlacementStore: ...
    @property
    def team_store(self) -> TeamStore: ...
    @property
    def project_store(self) -> ProjectStore: ...
    @property
    def managed_node_store(self) -> ManagedNodeStore: ...
    @property
    def registry(self) -> DaemonNodeRegistry: ...
    @property
    def backend(self) -> ServerDaemonNodeBackend: ...


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
