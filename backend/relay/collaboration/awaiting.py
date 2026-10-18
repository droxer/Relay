"""What a waiting task asks its human, computed once for every surface.

The web used to re-derive this from task status, the outcome's preamble, and
legacy gate wording; it now renders `awaiting` as the backend states it. A
wait recorded before waits carried ids still projects — with
`questionId: None` — so only this module knows the legacy reading.
"""

from __future__ import annotations

import re
from typing import Any

from ..core.human_waits import WAIT_KINDS
from .policy import BLOCKED_ROUND_PREAMBLE, round_result_options
from .work import WORK_NEEDS_ATTENTION

# The gate preamble, and the one it replaced. A surface's title already says
# the work stopped, so neither is worth quoting.
_GATE_PREAMBLES = (WORK_NEEDS_ATTENTION, "Work needs attention.")
# Records written before gate reasons were plain named internal assignment ids
# ("Work 6fc1… is not accepted: missing."), which mean nothing to a reader.
_LEGACY_GATE_WORDING = (
    (re.compile(r"Work \S+ is not accepted: (?:missing|missing evidence)\."),
     "A required step ended without reporting what it did."),
    (re.compile(r"Work \S+ is not accepted: done\."),
     "A required step says it is done but showed no checks to back that up."),
    (re.compile(r"Work \S+ is not accepted: (?:continue|blocked)\."),
     "A required step is not finished."),
    (re.compile(r"Work \S+ is not accepted: (.+?)\.(?=\s|$)"),
     r"A required step is not finished: \1."),
    (re.compile(r"Required contribution \S+ failed\."), "A required step failed to run."),
    (re.compile(r"Unresolved finding on \S+: "), "A review found a problem that is still open: "),
)
# A sentence said again straight after itself. Reasons recorded before
# `completion_blockers` deduped them repeat once per step that stopped.
_REPEATED_SENTENCE = re.compile(r"(?<!\S)([^.]+\.)(?:\s+\1)+(?=\s|$)")


def task_awaiting(task: dict[str, Any]) -> dict[str, Any] | None:
    """The wait a task is parked on, or None when it is not waiting.

    `resumable` says whether a reply in `sessionId` runs as the task's next
    round; a routine template's wait is shown but never resumed.
    """
    if task.get("status") != "waiting_for_human" or task.get("deletedAt"):
        return None
    raw_request = task.get("waitingRequest")
    request: dict[str, Any] = raw_request if isinstance(raw_request, dict) else {}
    question = _text(request.get("inputQuestion"))
    options = round_result_options(request.get("inputOptions"))
    notes = [note for note in (_text(item) for item in request.get("inputNotes") or []) if note]
    kind, reason = read_waiting_reason(task.get("waitingReason"))
    recorded = request.get("kind")
    if recorded in WAIT_KINDS:
        kind = recorded
    elif question or options:
        kind = "question"
    if kind == "question":
        text = question or (reason if not _is_gate(task.get("waitingReason")) else None)
    else:
        text, options = reason, []
    question_id = request.get("questionId")
    return {
        "questionId": question_id if isinstance(question_id, str) and question_id else None,
        "kind": kind,
        "text": text,
        "options": options,
        "notes": notes,
        "sessionId": task.get("waitingSessionId") or None,
        "resumable": not task.get("isRoutine"),
        **({"unreported": True} if kind == "check" and request.get("unreported") is True else {}),
    }


def with_awaiting(task: dict[str, Any]) -> dict[str, Any]:
    """The task as a response carries it: with its wait projected."""
    return {**task, "awaiting": task_awaiting(task)}


def read_waiting_reason(raw: Any) -> tuple[str, str | None]:
    """Split a recorded waiting reason into its kind and the words worth quoting."""
    reason = _text(raw) or ""
    if reason.startswith(BLOCKED_ROUND_PREAMBLE):
        return "question", reason[len(BLOCKED_ROUND_PREAMBLE):].strip() or None
    return "check", plain_gate_reason(reason) or None


def plain_gate_reason(reason: str) -> str:
    """A gate reason in words a person can act on."""
    preamble = next((item for item in _GATE_PREAMBLES if reason.startswith(item)), None)
    if preamble is None:
        return reason
    plain = reason[len(preamble):].strip()
    for pattern, replacement in _LEGACY_GATE_WORDING:
        plain = pattern.sub(replacement, plain)
    return _REPEATED_SENTENCE.sub(r"\1", plain)


def _is_gate(raw: Any) -> bool:
    reason = _text(raw) or ""
    return any(reason.startswith(item) for item in _GATE_PREAMBLES)


def _text(value: Any) -> str | None:
    return (value.strip() or None) if isinstance(value, str) else None
