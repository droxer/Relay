"""Task generation fencing and status projection for dedicated workflows."""
from __future__ import annotations

from typing import Any

from ...core.human_waits import question_id_for_run, wait_record
from ...sessions.controller import SessionController
from ...tasks.execution import request_execution_owner
from ..state import RegistryState


def assert_workflow_task_owner(registry: RegistryState, request: dict[str, Any], session: dict[str, Any]) -> None:
    if not request.get("taskId"):
        return
    if not registry.task_store:
        raise ValueError("workflow_task_store_required")
    task = registry.task_store.get_task(request["taskId"])
    if (task.get("deletedAt") or task.get("status") in ("done", "review", "cancelled")
        or task.get("executionOwner") != request_execution_owner(request)
        or task.get("ownerUserId") != session.get("ownerUserId")
        or task.get("projectId") != session.get("projectId")
        or task.get("assignedTeamId") != session.get("teamId")
        or (task.get("assignedWorkflowId") is not None and task["assignedWorkflowId"] !=
            (session["workflowRuns"][0]["teamSnapshot"].get("workflowId") or session.get("teamId")))
        or session["id"] not in task.get("linkedSessionIds", [])):
        raise ValueError("task_ownership_changed: workflow no longer owns this task")


def sync_workflow_task(registry: RegistryState, request: dict[str, Any], session: dict[str, Any]) -> None:
    if not request.get("taskId") or not registry.task_store:
        return
    run = session["workflowRuns"][0]
    status = {"completed": "done", "cancelled": "cancelled", "blocked": "blocked",
              "awaiting_approval": "waiting_for_human", "awaiting_input": "waiting_for_human",
              "ready": "assigned"}[run["status"]]
    task = registry.task_store.get_task(request["taskId"])
    if task.get("executionOwner") != request_execution_owner(request):
        return
    waiting_request = None
    if run["status"] == "awaiting_input":
        assignment = run["assignments"][run["currentIndex"]]
        result = next(item for item in reversed(run["attemptResults"])
                      if item["assignmentId"] == assignment["assignmentId"] and item["status"] == "question")
        # One stable id per finished attempt, including finalization repair.
        waiting_request = wait_record(
            "question", question_id_for_run(result["runId"]),
            question=result.get("question"), options=result.get("options"),
        )
    if task["status"] == status and (waiting_request is None or (
        task.get("waitingRequest") == waiting_request and task.get("waitingSessionId") == session["id"]
    )):
        return
    controller = SessionController(registry.store, task_store=registry.task_store,
                                   task_id=request["taskId"], task_execution_owner=request_execution_owner(request))
    messages = {"waiting_for_human": "Workflow step asks its owner a question." if run["status"] == "awaiting_input"
                else "Workflow step awaits owner approval.",
                "blocked": "Workflow step needs attention.", "done": "Workflow completed with all required recorded outputs.",
                "cancelled": "Workflow cancelled by owner.", "assigned": "Workflow step queued for execution."}
    controller._update_task_status(status, messages[status], {
        "sessionId": session["id"], "code": "workflow_blocked",
        **({"request": waiting_request} if waiting_request is not None else {}),
    })
