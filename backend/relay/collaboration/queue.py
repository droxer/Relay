"""Write the durable Thread follow-up Queue and its acceptance receipts."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

from ..persistence.events import relay_event


def queue_state(session: dict[str, Any]) -> dict[str, Any]:
    return deepcopy(session.get("messageQueue") or {"messages": [], "paused": False})


def _save_queue(
    store: Any, thread_id: str, state: dict[str, Any], receipt_id: str | None = None,
    *, input_fingerprint: str | None = None,
) -> None:
    event = relay_event("session.queue", thread_id, {"queue": state})
    if receipt_id:
        event["id"] = f"queue.accepted:{receipt_id}"
    if input_fingerprint:
        event["inputFingerprint"] = input_fingerprint
    store.append_event(thread_id, event, hydrate_events=False)


def _steering(state: dict[str, Any]) -> bool:
    return state.get("steeringUntil", "") > datetime.now(UTC).isoformat()


def live_pending(state: dict[str, Any]) -> bool:
    """A message was handed to the live run and its computer has not answered yet."""
    return (state.get("live") or {}).get("until", "") > datetime.now(UTC).isoformat()


def _promote(state: dict[str, Any], message_id: str) -> None:
    if state.get("sending") or _steering(state):
        raise ValueError("This message is being sent. Wait for it to finish.")
    messages = state["messages"]
    index = next((i for i, message in enumerate(messages) if message["id"] == message_id), None)
    if index is None:
        raise ValueError("This message was already changed on another device.")
    messages.insert(0, messages.pop(index))
    state.update(paused=False, sendRequested=True)
    state.pop("error", None)
    state.pop("steeringUntil", None)


def stop_and_send(
    store: Any, thread_id: str, message_id: str, cancel: Callable[[], Any],
) -> dict[str, Any]:
    # Commit a pause before asking the Computer to stop. If the old run exits
    # during cancellation, another dispatcher must still wait before sending.
    with store.mutation_scope(thread_id):
        session = store.get_session_header(thread_id)
        if session.get("deletionRequestedAt") or session.get("archived"):
            raise ValueError("This thread is archived or being deleted.")
        state = queue_state(session)
        _promote(state, message_id)
        lease = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
        state.update(paused=True, steeringUntil=lease)
        _save_queue(store, thread_id, state)
    stopped = False
    try:
        cancel()
        stopped = True
    finally:
        with store.mutation_scope(thread_id):
            state = queue_state(store.get_session_header(thread_id))
            if state.get("steeringUntil") == lease:
                state.pop("steeringUntil")
                if stopped and state.get("sendRequested"):
                    _promote(state, message_id)
                else:
                    state.pop("sendRequested", None)
                _save_queue(store, thread_id, state)
    return state


def _enqueue_message(
    state: dict[str, Any], message: dict[str, Any], receipt: dict[str, Any] | None, *, imported: bool,
) -> bool:
    """Append ``message`` to the queue. Returns False when an identical receipt already exists."""
    messages = state["messages"]
    original = (receipt or {}).get("queue", {}).get("messages", [])
    existing = next((m for m in [*messages, *original] if m["id"] == message["id"]), None)
    if existing:
        if existing != message:
            raise ValueError("This message ID already names another message.")
        return False
    if len(messages) >= 20:
        raise ValueError("The queue is full (20 messages).")
    messages.append(message)
    if imported:
        state["paused"] = True
        state.pop("sendRequested", None)
    return True


def _undo_removed_message(state: dict[str, Any], message_id: str) -> bool:
    """Restore the most recently removed message. Returns False when nothing matches."""
    removed = state.get("removed")
    if not removed or removed["message"]["id"] != message_id:
        return False
    messages = state["messages"]
    if len(messages) >= 20:
        raise ValueError("The queue is full (20 messages).")
    if not any(item["id"] == message_id for item in messages):
        index = next(
            (i for i, item in enumerate(messages) if item["id"] == removed.get("beforeId")),
            len(messages),
        )
        messages.insert(index, removed["message"])
    state.pop("removed", None)
    return True


def _remove_or_edit_message(state: dict[str, Any], message_id: str, *, action: str) -> bool:
    """Remove a queued message (recording undo info for ``remove``). Returns False on no-op."""
    if state.get("sending") == message_id or _steering(state):
        raise ValueError("This message is being sent. Wait for it to finish.")
    messages = state["messages"]
    picked = next((m for m in messages if m["id"] == message_id), None)
    if not picked:
        if action == "edit":
            raise ValueError("This message was already changed on another device.")
        return False
    if action == "remove":
        index = messages.index(picked)
        before_id = messages[index + 1]["id"] if index + 1 < len(messages) else None
        state["removed"] = {
            "message": picked,
            "beforeId": before_id,
            "removedAt": datetime.now(UTC).isoformat(),
        }
    state["messages"] = [m for m in messages if m["id"] != message_id]
    return True


def _set_queue_paused(state: dict[str, Any], *, paused: bool) -> None:
    if not paused and _steering(state):
        raise ValueError("This message is being sent. Wait for it to finish.")
    state["paused"] = paused
    state.pop("error", None)
    if paused or state.pop("steeringUntil", None):
        state.pop("sendRequested", None)


def change_queue(
    store: Any, thread_id: str, action: str, *, message: dict[str, Any] | None = None, message_id: str = "",
    resolve_message: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    with store.mutation_scope(thread_id):
        session = store.get_session_header(thread_id)
        state = queue_state(session)
        receipt = store.queue_receipt(thread_id, message["id"]) if message is not None else None
        fingerprint = None
        if message is not None and resolve_message is not None:
            normalized = {**message, "addressAgentIds": sorted(message.get("addressAgentIds", []))}
            encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()
            fingerprint = hashlib.sha256(encoded).hexdigest()
            if receipt and receipt.get("inputFingerprint"):
                if receipt["inputFingerprint"] != fingerprint:
                    raise ValueError("This message ID already names another message.")
                return state
            if receipt and _matches_legacy_queue_receipt(receipt, message):
                return state
        if action != "pause" and (session.get("deletionRequestedAt") or session.get("archived")):
            raise ValueError("This thread is archived or being deleted.")
        changed = True
        if action in ("enqueue", "import"):
            assert message is not None
            if resolve_message is not None:
                message = resolve_message(message)
            changed = _enqueue_message(state, message, receipt, imported=action == "import")
        elif action == "undo_remove":
            changed = _undo_removed_message(state, message_id)
        elif action == "promote":
            _promote(state, message_id)
        elif action in ("remove", "edit"):
            changed = _remove_or_edit_message(state, message_id, action=action)
        elif action in ("pause", "resume"):
            _set_queue_paused(state, paused=action == "pause")
        else:
            raise ValueError("Unknown queue action.")
        if changed:
            _save_queue(
                store, thread_id, state, message["id"] if message is not None else None,
                input_fingerprint=fingerprint,
            )
        return state


def _matches_legacy_queue_receipt(receipt: dict[str, Any], message: dict[str, Any]) -> bool:
    original = next((item for item in receipt["queue"]["messages"] if item["id"] == message["id"]), None)
    if not original:
        return False
    if original["text"] != message["text"] or original.get("addressTeamId") != message.get("addressTeamId"):
        raise ValueError("This message ID already names another message.")
    supplied = message.get("addressAgentIds", [])
    frozen = original.get("addressAgentIds", [])
    text = message["text"]
    return set(supplied) == set(frozen) or (
        not supplied and bool(frozen) and text.startswith("@") and bool(text[1:2].strip())
    )
