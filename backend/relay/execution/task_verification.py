"""Serialize changes to a required check and acceptance of its recorded result."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from ..core.task_verification import CHECK_FIELD, check_definition
from ..tasks.requests import TaskRequestError, update_task_unless_dispatching
from ..tasks.review import task_review


def update_verification_check(
    ctx: Any, task: dict[str, Any], user_id: str, body: dict[str, Any],
) -> dict[str, Any]:
    check = check_definition(body.get(CHECK_FIELD))
    if check is None or set(body) != {CHECK_FIELD}:
        raise TaskRequestError(400, "verificationCheck requires a full Git commit and path in its own request.")
    with ctx.registry.dispatch_lock, ctx.task_store.task_write_scope(task["id"]):
        current = ctx.task_store.get_task(task["id"])
        if current["ownerUserId"] != user_id:
            raise TaskRequestError(403, "task_verification_owner_required")
        if not current.get(CHECK_FIELD) or current["status"] in ("done", "cancelled"):
            raise TaskRequestError(409, "task_verification_check_locked")
        if check == current[CHECK_FIELD]:
            return current
        if current["status"] in ("queued", "running") or ctx.registry.daemon_store.active_run_request_for_task(task["id"]):
            raise TaskRequestError(409, "task_execution_active")
        return update_task_unless_dispatching(ctx, task["id"], {CHECK_FIELD: check, "actorUserId": user_id})


@contextmanager
def checked_review(
    ctx: Any, task: dict[str, Any], body: dict[str, Any], *, session_id: str | None = None,
) -> Iterator[None]:
    """An optional conditional acceptance, locked until the enclosing commit.

    Legacy PATCH callers remain supported. Review clients send the revision
    they displayed, never a freshly fetched revision at the moment of Accept.
    """
    if "reviewRevision" not in body and not (task.get(CHECK_FIELD) and body.get("status") == "done"):
        yield
        return
    if "reviewRevision" not in body:
        raise TaskRequestError(409, "task_verification_review_required")
    revision = body["reviewRevision"]
    if (not isinstance(revision, str) or len(revision) != 64
            or any(char not in "0123456789abcdef" for char in revision)
            or body.get("status") != "done" or set(body) != {"status", "reviewRevision"}):
        raise TaskRequestError(400, "reviewRevision requires a SHA-256 revision and status done only.")
    with ctx.task_store.task_write_scope(task["id"]):
        current = ctx.task_store.get_task(task["id"])
        brief = task_review(ctx, current, lock=True)
        if brief["revision"] != revision or session_id is not None and brief["sessionId"] != session_id:
            raise TaskRequestError(409, "task_review_changed")
        if current.get(CHECK_FIELD) and brief["verification"] != "passed":
            raise TaskRequestError(409, "task_verification_pass_required")
        yield
