from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

CollaborationPurpose = Literal["accomplish", "discuss", "review"]
RecoveryKind = Literal["rerun", "handoff"]
COLLABORATION_MANIFEST_STATE_KEY = "_relay_collaboration_manifest"
COLLABORATION_FINGERPRINT_STATE_KEY = "_relay_collaboration_fingerprint"
COLLABORATION_ADMISSION_EXPIRED_STATE_KEY = "_relay_collaboration_admission_expired"
COLLABORATION_NEW_SESSION_STATE_KEY = "_relay_collaboration_new_session"
COLLABORATION_ADMISSION_EXPIRED_OUTCOME = (
    "Collaboration admission expired before the round started."
)
COLLABORATION_ADMISSION_EXPIRED_ERROR = "Collaboration admission expired before its authoritative round event was committed."


class CollaborationIdempotencyError(ValueError):
    """The caller reused an admission key for a different semantic request."""


@dataclass(frozen=True)
class MessageIntent:
    thread_id: str
    text: str
    purpose: CollaborationPurpose = "accomplish"
    # Empty addresses the whole room. Several ids address several agents in one
    # round; agents that are not yet participants join the thread by being
    # addressed.
    address_agent_ids: tuple[str, ...] = ()
    # A team on the thread's computer that runs this round instead. Exclusive
    # with `address_agent_ids`; the thread keeps its own team (if any).
    address_team_id: str | None = None
    idempotency_key: str | None = None
    user_message_id: str | None = None
    # A collaboration style for this one round; None uses the team's style.
    style: str | None = None


@dataclass(frozen=True)
class RecoveryIntent:
    thread_id: str
    kind: RecoveryKind
    target_agent_id: str
    mode: str = "action"
    note: str | None = None
    idempotency_key: str | None = None


@dataclass(frozen=True)
class RunIntent:
    """Compatibility input while legacy callers migrate off assignments."""

    task_goal: str
    session_id: str | None
    raw_assignments: list[dict[str, Any]] | None
    mode: str = "action"
    requested_team_id: str | None = None
    requested_project_id: str | None = None
    requested_node_id: str | None = None
    idempotency_key: str | None = None
    user_message_id: str | None = None
    decision: dict[str, Any] | None = None
    source: str = "legacy"
    style: str | None = None
