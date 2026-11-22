"""Handing a queued follow-up to the thread's live run instead of stopping it.

"Send now" on a running thread first tries the run itself: when the run's
computer can carry a live message (`live-messages`) and the message is for the
agent that is working, the message is marked as handed over (`live`) and a
`run.steer` command goes to the computer. Its `run.steered` answer settles the
mark: a delivered message leaves the queue and enters the transcript as
`user.live_message`; one the run could not take falls back to stop-and-send.
A mark nobody answers expires, and the message is sent after the run like any
other queued follow-up.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from loguru import logger

from ..core.daemon_capabilities import DAEMON_CAPABILITY_LIVE_MESSAGES, has_capability
from ..core.ids import new_database_id
from ..persistence.events import relay_event
from .queue import _promote, _save_queue, queue_state

# How long a handed-over message waits for its computer's answer before it is
# sent after the run instead.
LIVE_ANSWER_SECONDS = 120


def _closed(session: dict[str, Any]) -> bool:
    return bool(session.get("deletionRequestedAt") or session.get("archived"))


def live_target(ctx: Any, session: dict[str, Any], message: dict[str, Any]) -> dict[str, Any] | None:
    """The one running run this message can be handed to, or None.

    A message addressed to a team, or to agents other than the one working,
    is a new round, not a word to the running agent.
    """
    if message.get("addressTeamId"):
        return None
    runs = ctx.registry.daemon_store.list_active_runs(session_ids={session["id"]})
    if len(runs) != 1:
        return None
    run = runs[0]
    addressed = message.get("addressAgentIds") or []
    if addressed and run.get("logicalAgentId") not in addressed:
        return None
    if not has_capability(ctx.registry.get(run["nodeId"]), DAEMON_CAPABILITY_LIVE_MESSAGES):
        return None
    return run


def send_live_message(ctx: Any, session: dict[str, Any], message_id: str) -> dict[str, Any] | None:
    """Hand a queued message to the live run; None when stop-and-send applies.

    Raises ValueError, like the queue's own changes, when the message is
    already being sent or changed elsewhere.
    """
    store = ctx.session_store
    thread_id = session["id"]
    message = next((m for m in queue_state(session)["messages"] if m["id"] == message_id), None)
    if not message:
        raise ValueError("This message was already changed on another device.")
    run = live_target(ctx, session, message)
    if not run:
        return None
    command_id = new_database_id()
    state = _claim(store, thread_id, message_id, command_id)
    try:
        ctx.registry.enqueue(run["nodeId"], {
            "id": command_id,
            "type": "run.steer",
            "commandId": run["commandId"],
            "sessionId": thread_id,
            "runId": run["runId"],
            "agent": run["agent"],
            "messageId": message_id,
            "text": message["text"],
            **({"logicalAgentId": run["logicalAgentId"]} if run.get("logicalAgentId") else {}),
        })
    except Exception:
        _release(store, thread_id, message_id)
        raise
    logger.info("Live message handed to run", thread_id=thread_id, run_id=run["runId"], message_id=message_id)
    return state


def _claim(store: Any, thread_id: str, message_id: str, command_id: str) -> dict[str, Any]:
    with store.mutation_scope(thread_id):
        session = store.get_session_header(thread_id)
        if _closed(session):
            raise ValueError("This thread is archived or being deleted.")
        state = queue_state(session)
        _promote(state, message_id)
        until = (datetime.now(UTC) + timedelta(seconds=LIVE_ANSWER_SECONDS)).isoformat()
        # `steeringUntil` holds edits and removal while the computer answers.
        state.update(live={"id": message_id, "commandId": command_id, "until": until}, steeringUntil=until)
        _save_queue(store, thread_id, state)
        return state


def _release(store: Any, thread_id: str, message_id: str) -> bool:
    """Drop the handed-over mark; True when the message is still queued."""
    with store.mutation_scope(thread_id):
        state = queue_state(store.get_session_header(thread_id))
        if (state.get("live") or {}).get("id") != message_id:
            return False
        state.pop("live", None)
        state.pop("steeringUntil", None)
        _save_queue(store, thread_id, state)
        return any(m["id"] == message_id for m in state["messages"])


def record_delivered(store: Any, thread_id: str, command: dict[str, Any], delivery: str) -> bool:
    """The run took the message: it leaves the queue and joins the transcript.

    False when there is nothing to record, because the mark was already
    settled or the message was since sent after the run.
    """
    message_id = command["messageId"]
    with store.mutation_scope(thread_id):
        session = store.get_session_header(thread_id)
        state = queue_state(session)
        if (state.get("live") or {}).get("id") != message_id:
            return False
        message = next((m for m in state["messages"] if m["id"] == message_id), None)
        state.pop("live", None)
        state.pop("steeringUntil", None)
        if message is None:
            _save_queue(store, thread_id, state)
            return False
        state["messages"] = [m for m in state["messages"] if m["id"] != message_id]
        state.pop("sendRequested", None)
        _save_queue(store, thread_id, state)
        event = relay_event("user.live_message", thread_id, {
            "text": message["text"],
            "runId": command["runId"],
            "agent": command["agent"],
            "delivery": delivery,
            **({"logicalAgentId": command["logicalAgentId"]} if command.get("logicalAgentId") else {}),
            **({"actorUserId": session["ownerUserId"]} if session.get("ownerUserId") else {}),
        })
        event["id"] = f"live_{message_id}"
        store.append_event(thread_id, event, hydrate_events=False)
    logger.info("Live message delivered", thread_id=thread_id, message_id=message_id, delivery=delivery)
    return True


def release_for_fallback(store: Any, thread_id: str, message_id: str) -> bool:
    """The run could not take the message: drop the mark so stop-and-send can
    promote it. True when the message is still queued and owed a send."""
    return _release(store, thread_id, message_id)
