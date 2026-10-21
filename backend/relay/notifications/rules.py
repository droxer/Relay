"""Which changes become in-app notifications, and who receives them.

Pure functions only: the task store calls ``task_notification_rows`` inside its
write transaction, and the computer watcher calls the computer builders after
it observes a transition. Notices carry facts (ids, names, statuses), never
rendered prose, so the web renders them in the reader's language.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

TASK_COMPLETED = "task_completed"
COMPUTER_STATUS = "computer_status"
CLIENT_OUTDATED = "client_outdated"
PERMISSION_REQUESTED = "permission_requested"
NOTIFICATION_KINDS: tuple[str, ...] = (
    TASK_COMPLETED, PERMISSION_REQUESTED, COMPUTER_STATUS, CLIENT_OUTDATED,
)


def task_recipients(task: dict[str, Any]) -> list[str]:
    """The task's owner and its human assignee, once each."""
    recipients: list[str] = []
    for key in ("ownerUserId", "assigneeUserId"):
        user_id = task.get(key)
        if isinstance(user_id, str) and user_id and user_id not in recipients:
            recipients.append(user_id)
    return recipients


def task_completion(before: dict[str, Any] | None, after: dict[str, Any]) -> str | None:
    """``review`` or ``done`` when this write finishes the task's work.

    Entering ``review`` means the agents finished and a person should look.
    Entering ``done`` straight from work (a task that needs no acceptance) is
    also a finish; ``review`` → ``done`` is not — that is a person accepting
    it, and they need no notice of their own click. A routine occurrence
    notifies only when it waits for review: a schedule that announced every
    successful run would bury everything else in the inbox.
    """
    if before is None or after.get("isRoutine") or after.get("deletedAt"):
        return None
    status, previous = after.get("status"), before.get("status")
    if status == previous:
        return None
    if status == "review":
        return "review"
    if status == "done" and previous != "review" and not after.get("sourceRoutineId"):
        return "done"
    return None


def status_actors(events: Sequence[dict[str, Any]]) -> set[str]:
    """The people whose own status change this write records."""
    return {
        str(event["actorUserId"]) for event in events
        if event.get("type") == "task.status" and event.get("actorUserId")
    }


def task_notification_rows(
    before: dict[str, Any] | None, after: dict[str, Any], events: Sequence[dict[str, Any]] = (),
) -> list[dict[str, Any]]:
    """Notices for this write; whoever changed the status themself gets none."""
    completion = task_completion(before, after)
    if not completion:
        return []
    data = {
        "taskId": after["id"],
        "title": after.get("title") or "",
        "status": completion,
        **({"number": after["number"]} if after.get("number") is not None else {}),
        **({"projectId": after["projectId"]} if after.get("projectId") else {}),
        **({"sourceRoutineId": after["sourceRoutineId"]} if after.get("sourceRoutineId") else {}),
    }
    actors = status_actors(events)
    return [
        {"user_id": user_id, "kind": TASK_COMPLETED, "data": data}
        for user_id in task_recipients(after) if user_id not in actors
    ]


def computer_name(node: dict[str, Any]) -> str:
    return str(node.get("displayName") or node.get("workspaceId") or node["id"])


def computer_status_rows(
    node: dict[str, Any], recipients: list[str], previous: str, current: str,
) -> list[dict[str, Any]]:
    data = {"nodeId": node["id"], "computerName": computer_name(node), "from": previous, "to": current}
    return [{"user_id": user_id, "kind": COMPUTER_STATUS, "data": data} for user_id in recipients]


def client_outdated_rows(
    node: dict[str, Any], recipients: list[str], missing: list[str],
) -> list[dict[str, Any]]:
    data = {"nodeId": node["id"], "computerName": computer_name(node), "missingCapabilities": missing}
    return [{"user_id": user_id, "kind": CLIENT_OUTDATED, "data": data} for user_id in recipients]


def permission_request_rows(session: dict[str, Any], request: dict[str, Any]) -> list[dict[str, Any]]:
    """A live run paused on a prompt tells the thread's owner: the run is stuck
    until someone answers, and nothing else on the thread says so to a person
    who is not looking at it. An ownerless legacy thread notifies nobody."""
    owner = session.get("ownerUserId")
    if not isinstance(owner, str) or not owner:
        return []
    data = {
        "sessionId": session["id"],
        "requestId": request["id"],
        "toolName": request["toolName"],
        "agent": request.get("agent"),
        "question": bool(request.get("questions")),
        **({"logicalAgentId": request["logicalAgentId"]} if request.get("logicalAgentId") else {}),
        **({"title": session["title"]} if session.get("title") else {}),
        **({"projectId": session["projectId"]} if session.get("projectId") else {}),
    }
    return [{"user_id": owner, "kind": PERMISSION_REQUESTED, "data": data}]
