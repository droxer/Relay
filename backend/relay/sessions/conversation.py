"""Assemble the prior-conversation transcript for a continued session.

When the user sends a follow-up turn into an existing session, the next agent
run gets a prepended block summarizing the conversation so far — every earlier
user turn plus each completed agent run's last assistant text. This is what
gives the agent memory across runs; without it each run is a stateless CLI
invocation that only sees the latest message.

The latest user turn (the message currently being dispatched) is excluded: the
prompt builder re-appends it as the final ``[User]`` block, so including it here
would duplicate it.
"""

from __future__ import annotations

from typing import Any

from .bridge import (
    ArtifactReader,
    agent_log_for_run,
    include_run_in_continuity,
    latest_user_turn_marker,
    run_continuity_suffix,
    run_continuity_text,
    run_marker,
)

_HISTORY_HEADER = "[Conversation so far]"
_HISTORY_ELISION = "[Earlier conversation omitted]"


def _elision(progress_file: str | None) -> str:
    """Say what was dropped, and where the agent can still find it.

    Elision is silent loss: on a task that runs for hours the decisions made
    early are exactly the ones that fall off the front. When the run keeps a
    durable progress log, the marker points at it instead of stopping at
    "omitted".
    """
    if not progress_file:
        return _HISTORY_ELISION
    return (
        f"[Earlier conversation omitted — consult `{progress_file}` in the workspace "
        "if present for earlier decisions and state; verify it against the current workspace]"
    )
_DEFAULT_MAX_HISTORY_BLOCKS = 24
_DEFAULT_MAX_HISTORY_CHARS = 16000


def _created_marker(session: dict[str, Any]) -> tuple[str, int]:
    for index, event in enumerate(session.get("events", [])):
        if event.get("type") == "session.created":
            return (event.get("timestamp") or session.get("createdAt", ""), index)
    return (session.get("createdAt", ""), -1)


def _user_turns(session: dict[str, Any]) -> list[tuple[tuple[str, int], str]]:
    """Return ``((timestamp, event_index), text)`` for each user turn."""
    turns: list[tuple[tuple[str, int], str]] = [(_created_marker(session), session.get("taskGoal", ""))]
    for index, event in enumerate(session.get("events", [])):
        if event.get("type") == "user.message":
            turns.append(((event.get("timestamp", ""), index), event.get("text", "")))
    return turns


def _agent_turns(session: dict[str, Any], store: ArtifactReader) -> list[tuple[tuple[str, int], dict[str, Any], str | None]]:
    """Return ``((timestamp, event_index), run, continuity_text)`` for visible runs."""
    turns: list[tuple[tuple[str, int], dict[str, Any], str | None]] = []
    for run in session.get("agentRuns", []):
        if not include_run_in_continuity(run):
            continue
        body = agent_log_for_run(session, run, store)
        text = run_continuity_text(run, body)
        turns.append((run_marker(session, run), run, text))
    return turns


def _history_len(blocks: list[str]) -> int:
    return len("\n\n".join(blocks))


def _truncate_tail(block: str, budget: int) -> str:
    if budget <= len(_HISTORY_ELISION):
        return _HISTORY_ELISION
    if len(block) <= budget:
        return block
    marker = "[Earlier content omitted]\n"
    tail_budget = max(0, budget - len(marker))
    return marker + block[-tail_budget:].lstrip()


def _cap_history_blocks(
    blocks: list[str],
    max_blocks: int,
    max_chars: int,
    progress_file: str | None = None,
) -> list[str]:
    if not blocks:
        return []
    elision = _elision(progress_file)
    content_budget = max_chars - len(_HISTORY_HEADER) - 2
    if max_blocks <= 0 or content_budget <= 0:
        return [elision]

    kept_reversed: list[str] = []
    omitted = False
    current_len = 0
    for block in reversed(blocks):
        separator_len = 2 if kept_reversed else 0
        next_len = current_len + separator_len + len(block)
        if len(kept_reversed) >= max_blocks or (kept_reversed and next_len > content_budget):
            omitted = True
            break
        if not kept_reversed and next_len > content_budget:
            kept_reversed.append(_truncate_tail(block, content_budget))
            omitted = True
            break
        kept_reversed.append(block)
        current_len = next_len

    kept = list(reversed(kept_reversed))
    if not omitted:
        return kept

    kept = [elision, *kept]
    while len(kept) > 1 and _history_len(kept) > content_budget:
        if len(kept) == 2:
            available = content_budget - len(elision) - 2
            kept[1] = _truncate_tail(kept[1], max(0, available))
            break
        kept.pop(1)
    return kept


def compute_conversation_history(
    session: dict[str, Any],
    store: ArtifactReader,
    *,
    max_blocks: int = _DEFAULT_MAX_HISTORY_BLOCKS,
    max_chars: int = _DEFAULT_MAX_HISTORY_CHARS,
    progress_file: str | None = None,
) -> str | None:
    """Build the conversation-so-far block for the next run on ``session``.

    Returns ``None`` when there is nothing prior to show (e.g. the very first
    turn of a new session, where the only user turn is the current message).
    """
    latest_user = latest_user_turn_marker(session)
    items: list[tuple[tuple[str, int], str, str]] = []
    for marker, text in _user_turns(session):
        if latest_user and marker >= latest_user:
            continue
        items.append((marker, "user", f"[User]\n{text}"))
    for marker, run, text in _agent_turns(session, store):
        if latest_user and marker >= latest_user:
            continue
        agent = run.get("agent", "agent")
        items.append((marker, "agent", f"[Assistant @{agent}{run_continuity_suffix(run)}]\n{text or '<no output>'}"))
    for index, event in enumerate(session.get("events", [])):
        if event.get("type") != "human.decision":
            continue
        marker = (event.get("timestamp") or "", index)
        if latest_user and marker >= latest_user:
            continue
        decision = event.get("decision") or {}
        note = decision.get("note")
        if decision.get("kind") != "handoff" or not isinstance(note, str) or not note.strip():
            continue
        target = decision.get("targetAgent") or "agent"
        if decision.get("targetAgentId"):
            target += f" ({decision['targetAgentId']})"
        items.append((marker, "handoff", f"[Historical handoff to @{target}]\n{note.strip()}"))

    items.sort(key=lambda item: item[0])

    if not items:
        return None

    blocks = _cap_history_blocks(
        [block for _, _, block in items], max_blocks, max_chars, progress_file
    )
    return _HISTORY_HEADER + "\n\n" + "\n\n".join(blocks)
