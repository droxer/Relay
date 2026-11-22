"""When a Thread's queued follow-up may continue automatically."""

from typing import Any


THREAD_QUEUE_READY_PREFIX = "thread-queue:"


def queue_can_continue(session: dict[str, Any]) -> bool:
    queue = session.get("messageQueue") or {}
    if (
        not queue.get("messages")
        or queue.get("paused")
        or session.get("archived")
        or session.get("deletionRequestedAt")
    ):
        return False
    # A claimed send keeps priority until admission and queue consumption
    # finish. Explicit send also overrides the ordinary human-wait gate.
    return bool(queue.get("sending") or queue.get("sendRequested")) or not (
        session.get("pendingDecision")
        or session.get("inputQuestion")
        or session.get("permissionRequests")
        or session.get("status") == "waiting_for_human"
        or session.get("workOutcome") == "blocked"
    )
