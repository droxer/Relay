"""A computer's answer to a live message (`run.steered`).

Delivered: the message leaves the queue and joins the transcript. Not taken
(`unavailable`, `failed`): the thread falls back to what "Send now" did before
live messages — stop the run and send the message next — acting for the
thread's owner, who asked for the send.
"""

from __future__ import annotations

from typing import Any, cast

from loguru import logger

from ...collaboration.live_queue import record_delivered, release_for_fallback
from ...collaboration.queue import stop_and_send
from ...daemon_registry.records import CommandEventMismatchError
from ...security.actor import Actor
from ..deps import AppContext
from .lifecycle import _cancel_thread_execution

FALLBACK_REASON = "Send queued message first."


def settle_live_message(ctx: AppContext, sandbox_id: str, event: dict[str, Any]) -> bool:
    """Apply one `run.steered`; True when a fallback send now waits on the run's exit."""
    try:
        record = ctx.daemon_store.complete_live_message_command(sandbox_id, event["commandId"])
    except KeyError:
        logger.info("Live message answer for an unknown command", sandbox_id=sandbox_id, command_id=event["commandId"])
        return False
    except (PermissionError, ValueError) as error:
        # The credential is good; the answer is not this node's to give.
        raise CommandEventMismatchError(str(error)) from error
    if record is None:
        return False
    command = record["command"]
    if any(command.get(key) != event.get(key) for key in ("sessionId", "runId", "messageId")):
        raise CommandEventMismatchError("Live message answer does not match its command.")
    thread_id = command["sessionId"]
    if event["outcome"] == "delivered":
        record_delivered(ctx.session_store, thread_id, command, event["delivery"])
        return False
    logger.info(
        "Live message not taken; stopping the run to send it",
        thread_id=thread_id, message_id=command["messageId"], outcome=event["outcome"], reason=event.get("reason"),
    )
    if not release_for_fallback(ctx.session_store, thread_id, command["messageId"]):
        return False
    owner = ctx.session_store.get_session_header(thread_id).get("ownerUserId")
    if not owner:
        return False
    actor = cast(Actor, {"userId": owner, "isAdmin": False})
    try:
        with ctx.registry.dispatch_lock:
            state = stop_and_send(
                ctx.session_store, thread_id, command["messageId"],
                lambda: _cancel_thread_execution(ctx, thread_id, actor, FALLBACK_REASON),
            )
    except ValueError as error:
        # The message moved meanwhile (removed, edited, or already sending); it is no longer owed.
        logger.info("Live message fallback skipped", thread_id=thread_id, message_id=command["messageId"], error=str(error))
        return False
    return bool(state.get("sendRequested"))
