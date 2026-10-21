"""Runtime permission prompts: a live run asks a person before a tool runs.

On a local computer with the native permission policy, the daemon gives Claude
a permission-prompt tool. Each prompt reaches the backend as a
`run.permission_requested` daemon event and is recorded on the thread as
`agent.permission_requested`; a person answers through
`POST /threads/{id}/permission-requests/{requestId}` (`agent.permission_resolved`),
and the daemon polls for that answer while the run waits.

The snapshot keeps the open prompts (`permissionRequests`) and a bounded
history of how each closed (`permissionDecisions`). A prompt closes once: a
person's allow/deny, or `expired` when its run ends first — the run is gone,
so nothing is left to answer — or when the daemon withdraws it
(`run.permission_withdrawn`: its runtime hung up, or nobody answered before
the daemon's deadline).

A prompt may be a question rather than an approval: the runtime's "ask the
user" tool (`questions`, each with offered answers). The person's `answers`
ride the `allow` decision back to the daemon, which hands them to the tool.
"""

from __future__ import annotations

import re
from typing import Any

PERMISSION_DECISIONS = ("allow", "deny")
PERMISSION_HISTORY_LIMIT = 50
PERMISSION_INPUT_MAX_CHARS = 4000
PERMISSION_TOOL_NAME_MAX_CHARS = 200
PERMISSION_NOTE_MAX_CHARS = 1000
# Mirrored by PERMISSION_QUESTIONS_LIMIT / PERMISSION_OPTIONS_LIMIT /
# PERMISSION_TEXT_LIMIT in relay-core's daemon-node-protocol.ts.
PERMISSION_QUESTIONS_MAX = 4
PERMISSION_OPTIONS_MAX = 8
PERMISSION_TEXT_MAX_CHARS = 500
PERMISSION_WITHDRAW_REASON_MAX_CHARS = 500
_REQUEST_ID = re.compile(r"^perm_[0-9a-f]{8,64}$")


def is_permission_request_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_REQUEST_ID.match(value))


def parse_permission_request(value: Any) -> dict[str, Any]:
    """The `request` of a `run.permission_requested` daemon event, validated."""
    if not isinstance(value, dict):
        raise ValueError("invalid run.permission_requested request.")
    request_id = value.get("id")
    tool_name = value.get("toolName")
    raw_input = value.get("input")
    tool_use_id = value.get("toolUseId")
    if not isinstance(request_id, str) or not _REQUEST_ID.match(request_id):
        raise ValueError("invalid permission request id.")
    if (
        not isinstance(tool_name, str)
        or not tool_name.strip()
        or len(tool_name) > PERMISSION_TOOL_NAME_MAX_CHARS
    ):
        raise ValueError("invalid permission request toolName.")
    if not isinstance(raw_input, str):
        raise ValueError("invalid permission request input.")
    if tool_use_id is not None and (
        not isinstance(tool_use_id, str) or len(tool_use_id) > PERMISSION_TOOL_NAME_MAX_CHARS
    ):
        raise ValueError("invalid permission request toolUseId.")
    preview = raw_input
    if len(preview) > PERMISSION_INPUT_MAX_CHARS:
        preview = preview[: PERMISSION_INPUT_MAX_CHARS - 1] + "…"
    questions = _parse_questions(value.get("questions"))
    return {
        "id": request_id,
        "toolName": tool_name.strip(),
        "input": preview,
        **({"toolUseId": tool_use_id} if tool_use_id else {}),
        **({"questions": questions} if questions else {}),
    }


def _text(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > PERMISSION_TEXT_MAX_CHARS:
        raise ValueError(f"invalid permission request {what}.")
    return value.strip()


def _parse_questions(value: Any) -> list[dict[str, Any]]:
    """The questions a runtime asks, each with its offered answers."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > PERMISSION_QUESTIONS_MAX:
        raise ValueError("invalid permission request questions.")
    questions: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("invalid permission request question.")
        options = raw.get("options") or []
        if not isinstance(options, list) or len(options) > PERMISSION_OPTIONS_MAX:
            raise ValueError("invalid permission request question options.")
        parsed_options = []
        for option in options:
            if not isinstance(option, dict):
                raise ValueError("invalid permission request question option.")
            description = option.get("description")
            parsed_options.append({
                "label": _text(option.get("label"), "question option"),
                **({"description": _text(description, "question option")} if description else {}),
            })
        questions.append({
            "id": _text(raw.get("id"), "question id"),
            "text": _text(raw.get("text"), "question text"),
            "options": parsed_options,
            **({"multiSelect": True} if raw.get("multiSelect") is True else {}),
        })
    return questions


def validate_answers(request: dict[str, Any], value: Any) -> dict[str, list[str]]:
    """A person's answers to an open question prompt: one non-empty list per
    question, each entry an offered label or the person's own words. Raises
    ValueError naming what is wrong."""
    questions = request.get("questions") or []
    if not questions:
        raise ValueError("this prompt takes no answers.")
    if not isinstance(value, dict):
        raise ValueError("answers must be an object keyed by question id.")
    answers: dict[str, list[str]] = {}
    for question in questions:
        given = value.get(question["id"])
        picks = given if isinstance(given, list) else [given] if given is not None else []
        texts = [pick.strip() for pick in picks if isinstance(pick, str) and pick.strip()]
        if not texts:
            raise ValueError(f"answer the question: {question['text']}")
        if any(len(text) > PERMISSION_TEXT_MAX_CHARS for text in texts):
            raise ValueError("an answer is too long.")
        if len(texts) > 1 and not question.get("multiSelect"):
            raise ValueError(f"pick one answer for: {question['text']}")
        answers[question["id"]] = texts
    return answers


def permission_request_status(session: dict[str, Any], request_id: str) -> dict[str, Any] | None:
    """What the daemon polling for `request_id` should do, or None if unknown."""
    if open_permission_request(session, request_id):
        return {"status": "pending"}
    for decision in session.get("permissionDecisions") or []:
        if decision["requestId"] == request_id:
            return {
                "status": decision["decision"],
                **({"note": decision["note"]} if decision.get("note") else {}),
                **({"answers": decision["answers"]} if decision.get("answers") else {}),
            }
    return None


def permission_request_node(session: dict[str, Any], request_id: str) -> str | None:
    """The computer whose run asked — the only one that may poll the answer."""
    for item in [
        *(session.get("permissionRequests") or []),
        *(
            {"id": decision["requestId"], "daemonNodeId": decision.get("daemonNodeId")}
            for decision in session.get("permissionDecisions") or []
        ),
    ]:
        if item["id"] == request_id:
            return item.get("daemonNodeId")
    return None


def open_permission_request(session: dict[str, Any], request_id: str) -> dict[str, Any] | None:
    return next(
        (item for item in session.get("permissionRequests") or [] if item["id"] == request_id),
        None,
    )


def apply_permission_requested(session: dict[str, Any], event: dict[str, Any]) -> None:
    request = event["request"]
    request_id = request["id"]
    # A retried daemon post must not reopen a prompt, open or already answered.
    if open_permission_request(session, request_id) or any(
        decision["requestId"] == request_id
        for decision in session.get("permissionDecisions") or []
    ):
        return
    session.setdefault("permissionRequests", []).append(
        {**request, "requestedAt": event["timestamp"]}
    )


def apply_permission_resolved(session: dict[str, Any], event: dict[str, Any]) -> None:
    request = open_permission_request(session, event["requestId"])
    if not request:
        return
    _close(
        session,
        request,
        event["decision"],
        event["timestamp"],
        note=event.get("note"),
        decided_by=event.get("actorUserId"),
        answers=event.get("answers"),
    )


def expire_permission_requests(
    session: dict[str, Any], timestamp: str, *, run_id: str | None = None
) -> None:
    """Close every open prompt of `run_id` (or of the thread) as expired."""
    for request in list(session.get("permissionRequests") or []):
        if run_id is None or request.get("runId") == run_id:
            _close(session, request, "expired", timestamp)


def _close(
    session: dict[str, Any],
    request: dict[str, Any],
    decision: str,
    timestamp: str,
    *,
    note: str | None = None,
    decided_by: str | None = None,
    answers: dict[str, list[str]] | None = None,
) -> None:
    remaining = [
        item for item in session.get("permissionRequests") or [] if item["id"] != request["id"]
    ]
    if remaining:
        session["permissionRequests"] = remaining
    else:
        session.pop("permissionRequests", None)
    history = [
        *(session.get("permissionDecisions") or []),
        {
            "requestId": request["id"],
            "runId": request.get("runId"),
            **({"daemonNodeId": request["daemonNodeId"]} if request.get("daemonNodeId") else {}),
            "toolName": request["toolName"],
            "decision": decision,
            "resolvedAt": timestamp,
            **({"note": note} if note else {}),
            **({"decidedBy": decided_by} if decided_by else {}),
            **({"answers": answers} if answers else {}),
        },
    ]
    session["permissionDecisions"] = history[-PERMISSION_HISTORY_LIMIT:]
