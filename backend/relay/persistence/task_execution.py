"""Event-backed task execution generations, independent of run retention."""

from typing import Any


def prepare_execution_events(
    task: dict[str, Any],
    events: list[dict[str, Any]],
    execution_owner: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Called only inside the task store's write lock/transaction."""
    owner = task.get("executionOwner")
    for event in events:
        if event.get("type") == "task.updated" and "expectedStatus" in event:
            if task.get("status") != event["expectedStatus"] or (owner or {}).get(
                "revision", 0
            ) != event.get("expectedExecutionRevision", 0):
                raise ValueError(
                    "task_state_changed: Reload the task before changing its workflow."
                )

    if execution_owner is not None:
        legacy = owner is None and execution_owner.get("revision") == 0
        if task.get("deletedAt") or (not legacy and owner != execution_owner):
            return []
    claims = [
        event for event in events if event.get("type") == "task.execution.claimed"
    ]
    if not claims:
        return events
    if len(events) != 1:
        raise ValueError("task_ownership_changed: claim must be a separate transition")
    claim = claims[0]
    expected = claim.get("expectedRevision")
    request_id = claim.get("requestId")
    if (
        type(expected) is not int
        or expected < 0
        or not isinstance(request_id, str)
        or not request_id
        or task.get("deletedAt")
        or task.get("isRoutine")
    ):
        raise ValueError("task_ownership_changed: invalid execution claim")
    if owner == {"requestId": request_id, "revision": expected + 1}:
        return []
    if "expectedStatus" in claim and task.get("status") != claim["expectedStatus"]:
        raise ValueError(
            "task_ownership_changed: task workflow changed during admission"
        )
    if (owner or {}).get("revision", 0) != expected:
        raise ValueError("task_ownership_changed: task execution owner changed")
    return [{**claim, "revision": expected + 1}]


def request_execution_owner(request: dict[str, Any]) -> dict[str, Any]:
    return {
        "requestId": request["id"],
        "revision": (request.get("state") or {}).get(
            "_relay_task_execution_revision", 0
        ),
    }
