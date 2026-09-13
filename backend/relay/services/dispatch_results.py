"""Serialize post-admission bookkeeping with task ownership changes."""
from contextlib import contextmanager


@contextmanager
def dispatch_result_scope(store, source_task, claim_id, *, success):
    from ..daemon_registry.node_backend import _idempotent_run_request_id

    with store.task_write_scope(source_task["id"]) as current:
        owner = current.get("executionOwner")
        same_owner = owner == source_task.get("executionOwner")
        accepted_owner = bool(claim_id and owner and owner.get("requestId") == _idempotent_run_request_id(claim_id))
        same_claim = (current.get("dispatchClaim") or {}).get("id") == claim_id
        allowed_status = current.get("status") in (("assigned", "running") if success else ("assigned",))
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
