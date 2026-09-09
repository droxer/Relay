"""Compute the prior-agent bridge string for a multi-agent session.

When a session contains runs from multiple agents, the daemon prompt for the
next agent gets a short prepended block summarizing completed current-turn
agent runs' last assistant text. See
``docs/superpowers/specs/2026-06-17-shared-agent-thread-design.md``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Protocol


class ArtifactReader(Protocol):
    def read_artifact(self, session_id: str, artifact_id: str) -> str: ...


_NOISE_PREFIXES = ("○ ", "⏺ ")  # "○ ", "⏺ "
_ASSISTANT_SPLIT = re.compile(r"\n?● ")  # "● "
_CONTINUITY_STATUSES = {None, "completed", "failed", "cancelled"}
_OUTPUT_TAIL_LINES = 20
_OUTPUT_TAIL_CHARS = 1200
_MAX_BRIDGE_CHARS = 16000
_MAX_BRIDGE_BLOCKS = 24


def extract_last_assistant_text(transcript: str) -> str | None:
    """Return the last ``●`` segment of an agent transcript, trimmed.

    Returns ``None`` when no segment exists or when every segment is empty
    after stripping ``○``/``⏺`` noise lines.
    """
    if not transcript or not transcript.strip():
        return None
    segments = _ASSISTANT_SPLIT.split(transcript)[1:]
    for segment in reversed(segments):
        cleaned = "\n".join(
            line
            for line in segment.split("\n")
            if not any(line.startswith(prefix) for prefix in _NOISE_PREFIXES)
        ).strip()
        if cleaned:
            return cleaned
    return _extract_stream_json_assistant_text(transcript)


def _extract_stream_json_assistant_text(transcript: str) -> str | None:
    """Extract the terminal answer when an agent log retained raw JSONL.

    Rendered command logs use ``●`` markers, but completed Claude logs can be
    capped from the head while still retaining their final stream-json result.
    Continuity must understand both forms or a successful teammate is bridged
    as ``<no output>``.
    """
    for line in reversed(transcript.splitlines()):
        candidate = line.strip()
        if not candidate.startswith("{"):
            continue
        try:
            event = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        result = event.get("result")
        if event.get("type") == "result" and isinstance(result, str) and result.strip():
            return result.strip()
        if event.get("type") != "assistant":
            continue
        message = event.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str) and content.strip():
            return content.strip()
        if not isinstance(content, list):
            continue
        text = "\n".join(
            block["text"].strip()
            for block in content
            if isinstance(block, dict)
            and block.get("type") == "text"
            and isinstance(block.get("text"), str)
            and block["text"].strip()
        )
        if text:
            return text
    return None


def include_run_in_continuity(run: dict[str, Any]) -> bool:
    return run.get("status") in _CONTINUITY_STATUSES


def run_continuity_suffix(run: dict[str, Any]) -> str:
    status = run.get("status") or "completed"
    if status == "completed":
        return ""
    if status == "failed":
        exit_code = run.get("exitCode")
        return f" - failed, exit {exit_code}" if exit_code is not None else " - failed"
    if status == "cancelled":
        return " - cancelled"
    return f" - {status}"


def _output_tail(transcript: str | None) -> str | None:
    if not transcript:
        return None
    lines = [
        line
        for line in transcript.splitlines()
        if line.strip() and not any(line.startswith(prefix) for prefix in _NOISE_PREFIXES)
    ]
    if not lines:
        return None
    tail = "\n".join(lines[-_OUTPUT_TAIL_LINES:]).strip()
    if len(tail) > _OUTPUT_TAIL_CHARS:
        tail = tail[-_OUTPUT_TAIL_CHARS:].lstrip()
    return tail or None


def run_continuity_text(run: dict[str, Any], transcript: str | None) -> str | None:
    assistant_text = extract_last_assistant_text(transcript) if transcript else None
    if assistant_text or (run.get("status") or "completed") == "completed":
        return assistant_text
    return _output_tail(transcript)


def _bridge_artifact_for_run(session: dict[str, Any], run: dict[str, Any]) -> dict[str, Any] | None:
    """Pick the artifact that carries the run's rendered transcript."""
    artifact_ids = run.get("artifactIds") or []
    artifacts = {a["id"]: a for a in session.get("artifacts", [])}
    for artifact_id in reversed(artifact_ids):
        artifact = artifacts.get(artifact_id)
        if not artifact:
            continue
        if artifact.get("kind") in ("command_log", "review", "agent_output"):
            return artifact
    return None


def agent_log_for_run(session: dict[str, Any], run: dict[str, Any], store: ArtifactReader) -> str | None:
    """Return the run transcript without treating it as a user-visible artifact."""
    if isinstance(run.get("agentLog"), str):
        return run["agentLog"]
    run_id = run.get("id")
    for event in reversed(session.get("events", [])):
        if event.get("type") == "agent.completed" and event.get("runId") == run_id and isinstance(event.get("agentLog"), str):
            return event["agentLog"]
    artifact = _bridge_artifact_for_run(session, run)
    if not artifact:
        return None
    try:
        return store.read_artifact(session["id"], artifact["id"])
    except (KeyError, FileNotFoundError):
        return None


def latest_user_turn_timestamp(session: dict[str, Any]) -> str | None:
    """Return the timestamp for the latest user turn in ``session``.

    ``session.created`` carries the first user turn as ``taskGoal``; later
    follow-ups are persisted as ``user.message`` events.
    """
    timestamps: list[str] = []
    if session.get("createdAt"):
        timestamps.append(session["createdAt"])
    for event in session.get("events", []):
        if event.get("type") == "user.message" and event.get("timestamp"):
            timestamps.append(event["timestamp"])
    return max(timestamps) if timestamps else None


def latest_user_turn_marker(session: dict[str, Any]) -> tuple[str, int] | None:
    """Return ``(timestamp, event_index)`` for the latest user turn."""
    markers: list[tuple[str, int]] = []
    if session.get("createdAt"):
        markers.append((session["createdAt"], -1))
    for index, event in enumerate(session.get("events", [])):
        if event.get("type") == "session.created" and event.get("timestamp"):
            markers.append((event["timestamp"], index))
        elif event.get("type") == "user.message" and event.get("timestamp"):
            markers.append((event["timestamp"], index))
    return max(markers) if markers else None


def latest_user_turn_text(session: dict[str, Any]) -> str:
    """Return the current prompt using the same turn boundary as continuity."""
    marker = latest_user_turn_marker(session)
    if marker and marker[1] >= 0:
        event = session["events"][marker[1]]
        if event.get("type") == "user.message":
            return event["text"]
    return session.get("taskGoal") or ""


def _run_timestamp(run: dict[str, Any]) -> str:
    return run.get("completedAt") or run.get("startedAt") or ""


def run_marker(session: dict[str, Any], run: dict[str, Any]) -> tuple[str, int]:
    timestamp = _run_timestamp(run)
    run_id = run.get("id")
    for index, event in enumerate(session.get("events", [])):
        if event.get("type") == "agent.completed" and event.get("runId") == run_id:
            return (event.get("timestamp") or timestamp, index)
    return (timestamp, -1)


def compute_prior_agent_bridge(
    session: dict[str, Any],
    agent: str,
    store: ArtifactReader,
) -> str | None:
    """Build the bridge string for the next run of ``agent`` on ``session``.

    Every completed run in the current user turn is shared with the next
    agent, even when the next run uses the same agent again. This keeps
    handoffs continuous inside one conversation while older turns remain in
    ``prior_conversation``.
    """
    runs = session.get("agentRuns") or []
    latest_user = latest_user_turn_marker(session)
    prior_runs = [
        r
        for r in runs
        if include_run_in_continuity(r) and (not latest_user or run_marker(session, r) > latest_user)
    ]
    if not prior_runs:
        return None

    blocks: list[str] = []
    for run in prior_runs:
        body = agent_log_for_run(session, run, store)
        text = run_continuity_text(run, body)
        blocks.append(f"[Previous from @{run.get('agent')}{run_continuity_suffix(run)}]\n{text or '<no output>'}")

    if len(blocks) <= _MAX_BRIDGE_BLOCKS and len("\n\n".join(blocks)) <= _MAX_BRIDGE_CHARS:
        return "\n\n".join(blocks)
    marker = "[Earlier agent context omitted; consult the shared progress log if present and prior run logs.]"
    budget = _MAX_BRIDGE_CHARS - len(marker) - 2
    kept: list[str] = []
    for block in reversed(blocks):
        remaining = budget - sum(len(item) + 2 for item in kept)
        if len(kept) >= _MAX_BRIDGE_BLOCKS or remaining <= 0:
            break
        if len(block) > remaining:
            if not kept:
                header, _, body = block.partition("\n")
                prefix = header + "\n[Earlier content omitted]\n"
                kept.append(prefix + body[-(remaining - len(prefix)):])
            break
        kept.append(block)
    return "\n\n".join([marker, *reversed(kept)])
