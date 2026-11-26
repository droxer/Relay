"""Fence dispatch writes against changes to the Task while routing or admitting it."""
from contextlib import contextmanager
from typing import Any

from ..core.run_request_ids import idempotent_run_request_id
from ..persistence.protocols import TaskStore
from .claims import dispatch_claim_active


def update_pending_dispatch(
    store: TaskStore, task_id: str, fields: dict[str, Any],
) -> dict[str, Any]:
    """Routing used a snapshot. A manual completion may have won since then."""
    with store.task_write_scope(task_id) as current:
        if current["status"] not in ("backlog", "assigned", "queued") or current.get("deletedAt"):
            return current
        if dispatch_claim_active(current):
            return current
        return store.update_task(task_id, fields)


@contextmanager
def dispatch_result_scope(store, source_task, claim_id, *, success):

    with store.task_write_scope(source_task["id"]) as current:
        owner = current.get("executionOwner")
        same_owner = owner == source_task.get("executionOwner")
        accepted_owner = bool(claim_id and owner and owner.get("requestId") == idempotent_run_request_id(claim_id))
        same_claim = (current.get("dispatchClaim") or {}).get("id") == claim_id
        allowed_status = current.get("status") in (("assigned", "queued", "running") if success else ("assigned", "queued"))
        if not same_claim or not (same_owner or accepted_owner) or current.get("deletedAt"):
            yield None
        elif not allowed_status or (not success and not same_owner):
            # Release only our own claim, never a replacement's. A terminal
            # task must not retain an old idempotency key for its next dispatch.
            if claim_id:
                store.release_dispatch_claim(current["id"], claim_id)
            yield None
        else:
            yield current
