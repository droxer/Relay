"""Turn a message, recovery, or legacy run intent into one prepared round.

Also the request identity a retry is matched by (scoped idempotency key and
fingerprint) and the checks a round's scope must pass before it has a roster.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any

from ..sessions.bridge import latest_user_turn_text
from .errors import CollaborationError
from .models import MessageIntent, RecoveryIntent, RunIntent

VALID_MODES = frozenset({"action", "ask", "review"})
VALID_ROLES = frozenset({"implementer", "reviewer", "planner", "tester", "fixer"})


@dataclass(frozen=True)
class _PreparedRound:
    task_goal: str
    session_id: str | None
    raw_assignments: list[dict[str, Any]] | None
    mode: str
    requested_team_id: str | None
    address_team_id: str | None
    requested_project_id: str | None
    requested_node_id: str | None
    idempotency_key: str | None
    user_message_id: str | None
    decision: dict[str, Any] | None
    source: str
    purpose: str
    address: dict[str, Any]
    style: str | None = None
    project_setup: dict[str, Any] | None = None
    task_id: str | None = None
    question_id: str | None = None
    approve: bool = False


# What a caller may say about a participant it names. Identity (`assignmentId`)
# and authority (`coordinator`, `synthesizer`, `required`, acceptance
# criteria, expected outputs, team snapshot) come from the conductor and the
# team's own configuration, never from the request.
CLIENT_ASSIGNMENT_FIELDS = ("agentId", "mode", "role", "brief")


def _client_assignments(
    raw_assignments: list[Any] | None,
) -> list[Any] | None:
    if raw_assignments is None:
        return None
    return [
        {key: item[key] for key in CLIENT_ASSIGNMENT_FIELDS if key in item}
        if isinstance(item, dict)
        else item
        for item in raw_assignments
    ]


def _scoped_idempotency_key(
    actor_user_id: str, session_id: str | None, caller_key: str
) -> str:
    resource = session_id or "new-thread"
    digest = hashlib.sha256(
        f"{actor_user_id}\0{resource}\0{caller_key}".encode()
    ).hexdigest()
    return f"collaboration:{digest}"


def _request_fingerprint(intent: _PreparedRound) -> str:
    payload = asdict(intent)
    payload.pop("idempotency_key", None)
    # Each setup draft creates its own task, so like the draft id below it is
    # identity, not request content, and must not make a retry conflict.
    payload.pop("task_id", None)
    # Unset style is omitted so fingerprints recorded before styles existed
    # still match a retry of the same request.
    if payload.get("style") is None:
        payload.pop("style", None)
    if payload.get("question_id") is None:
        payload.pop("question_id", None)
    if not payload.get("approve"):
        payload.pop("approve", None)
    if payload.get("project_setup") is None:
        payload.pop("project_setup", None)
    else:
        # Draft identity fences result writes; it is not part of the owner's
        # request and must not make an otherwise identical retry conflict.
        payload["project_setup"].pop("draftId", None)
    # Addressing the same text to a different set of agents is a different
    # request; addressing the same set in a different order is not.
    address = payload.get("address")
    if isinstance(address, dict) and isinstance(address.get("agentIds"), list):
        payload["address"] = {**address, "agentIds": sorted(address["agentIds"])}
    assignments = payload.get("raw_assignments")
    if isinstance(assignments, list):
        payload["raw_assignments"] = sorted(
            assignments,
            key=lambda item: str(item.get("agentId"))
            if isinstance(item, dict)
            else "",
        )
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def _mode(value: Any) -> str:
    return value if value in VALID_MODES else "action"


def _role(value: Any) -> str | None:
    return value if value in VALID_ROLES else None


def _purpose_for_mode(mode: Any) -> str:
    if mode == "ask":
        return "discuss"
    if mode == "review":
        return "review"
    return "accomplish"


def _prepare_message(intent: MessageIntent) -> _PreparedRound:
    purpose_modes = {
        "accomplish": "action",
        "discuss": "ask",
        "review": "review",
    }
    addressed_ids = list(dict.fromkeys(intent.address_agent_ids))
    raw_assignments = (
        [
            {"agentId": agent_id, "mode": purpose_modes[intent.purpose]}
            for agent_id in addressed_ids
        ]
        if addressed_ids
        else None
    )
    address = (
        {"kind": "members", "agentIds": addressed_ids}
        if addressed_ids
        else {"kind": "team", "teamId": intent.address_team_id}
        if intent.address_team_id
        else {"kind": "room"}
    )
    return _PreparedRound(
        task_goal=intent.text,
        session_id=intent.thread_id,
        raw_assignments=raw_assignments,
        mode=purpose_modes[intent.purpose],
        requested_team_id=None,
        address_team_id=intent.address_team_id,
        requested_project_id=None,
        requested_node_id=None,
        idempotency_key=intent.idempotency_key or intent.user_message_id,
        user_message_id=intent.user_message_id,
        decision=None,
        source="message",
        purpose=intent.purpose,
        address=address,
        style=intent.style,
        question_id=intent.question_id,
        approve=intent.approve,
    )


def _prepare_recovery(intent: RecoveryIntent) -> _PreparedRound:
    mode = _mode(intent.mode)
    return _PreparedRound(
        task_goal="",
        session_id=intent.thread_id,
        raw_assignments=[{"agentId": intent.target_agent_id, "mode": mode}],
        mode=mode,
        requested_team_id=None,
        address_team_id=None,
        requested_project_id=None,
        requested_node_id=None,
        idempotency_key=intent.idempotency_key,
        user_message_id=None,
        decision={
            "kind": intent.kind,
            "targetAgentId": intent.target_agent_id,
            **({"note": intent.note} if intent.note else {}),
            **({"resume": True} if intent.resume else {}),
        },
        source="recovery",
        purpose=_purpose_for_mode(mode),
        address={
            "kind": "members",
            "agentIds": [intent.target_agent_id],
        },
    )


def _prepare_run(intent: RunIntent) -> _PreparedRound:
    raw_assignments = _client_assignments(intent.raw_assignments)
    addressed = [
        item.get("agentId")
        for item in (raw_assignments or [])
        if isinstance(item, dict) and isinstance(item.get("agentId"), str)
    ]
    return _PreparedRound(
        task_goal=intent.task_goal,
        session_id=intent.session_id,
        raw_assignments=raw_assignments,
        mode=_mode(intent.mode),
        requested_team_id=intent.requested_team_id,
        address_team_id=None,
        requested_project_id=intent.requested_project_id,
        requested_node_id=intent.requested_node_id,
        idempotency_key=intent.idempotency_key,
        user_message_id=intent.user_message_id,
        decision=intent.decision,
        source=intent.source,
        style=intent.style,
        project_setup=intent.project_setup,
        task_id=intent.task_id,
        purpose=_purpose_for_mode(intent.mode),
        address=(
            {"kind": "members", "agentIds": addressed}
            if addressed
            else {"kind": "room"}
        ),
    )


def _round_task_goal(
    intent: _PreparedRound, session: dict[str, Any] | None
) -> str:
    """A recovery reruns the thread's latest ask; anything else brings its own."""
    task_goal = (
        latest_user_turn_text(session)
        if intent.source == "recovery" and session
        else intent.task_goal
    )
    if not isinstance(task_goal, str) or not task_goal:
        raise CollaborationError("task_goal_required", status=400)
    return task_goal


def _round_scope_ids(
    intent: _PreparedRound, session: dict[str, Any] | None
) -> tuple[str | None, str | None]:
    """The thread's team and project; a request may not contradict them."""
    session_team_id = session.get("teamId") if session else None
    if (
        session
        and intent.requested_team_id
        and intent.requested_team_id != session_team_id
    ):
        raise CollaborationError(
            "team_mismatch",
            "teamId does not match this thread's team.",
            status=400,
        )
    team_id = session_team_id or intent.requested_team_id
    session_project_id = session.get("projectId") if session else None
    if (
        session
        and intent.requested_project_id
        and intent.requested_project_id != session_project_id
    ):
        raise CollaborationError(
            "project_mismatch",
            "projectId does not match this thread's project.",
            status=400,
        )
    project_id = session_project_id or intent.requested_project_id
    # A project thread is the project's room: team work enters through a task.
    if (team_id or intent.address_team_id) and project_id:
        raise CollaborationError("project_team_conflict", status=400)
    return team_id, project_id


def _is_recovery_decision(decision: dict[str, Any] | None) -> bool:
    return isinstance(decision, dict) and decision.get("kind") in (
        "rerun",
        "handoff",
    )


def _assert_style_allowed(intent: _PreparedRound, round_team_id: str | None) -> None:
    if intent.style is not None and (
        intent.purpose != "accomplish"
        or intent.address.get("kind") == "members"
        or not round_team_id
    ):
        raise CollaborationError(
            "style_requires_team",
            "Collaboration style applies to team work requests only.",
            status=400,
        )
