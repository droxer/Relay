"""Pure turn-finalization decisions and the finalization retry schedule.

``decide_turn_finalization`` and ``decide_completed_turn`` read a run request and the
daemon event and return a small frozen description; ``progression.py`` applies it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from ...collaboration.work import (
    WORK_PROTOCOL, validate_work_result,
)
from ...collaboration.policy import (
    ROUND_RESULT_REJECTIONS,
    is_question,
)
from ..records import (
    ARTIFACT_SNAPSHOT_STATE_KEY,
    FOLLOW_UP_FAILURE_STATE_KEY,
    TERMINAL_CLAIM_EXPIRES_STATE_KEY,
    TERMINAL_CLAIM_ID_STATE_KEY,
    TERMINAL_EVENT_STATE_KEY,
)



FINALIZATION_ATTEMPTS_STATE_KEY = "_relay_finalization_attempts"
FINALIZATION_RETRY_AT_STATE_KEY = "_relay_finalization_retry_at"
RECOVERY_REQUIRED_STATE_KEY = "_relay_recovery_required"
FINALIZATION_RETRY_BASE_SECONDS = 5
FINALIZATION_RETRY_MAX_SECONDS = 300
FINALIZATION_RETRY_MAX_EXPONENT = 6
# A finalization that has failed this many times in a row is no longer a
# transient blip: its backoff (5 + 10 + 20 + 40 + 80 s) has spanned about two
# and a half minutes, longer than a database failover or a replica restart.
# From this attempt on the request is flagged ``_relay_recovery_required`` for a
# person, and every further failure is logged at error level with its attempt
# count so a permanently failing finalization is visible in the logs. Retrying
# never stops: releasing the reservation needs daemon exit evidence or a
# recorded human assertion. Once the backoff reaches its 300 s cap the error
# repeats at most every five minutes, which keeps it visible without flooding.
FINALIZATION_ESCALATION_ATTEMPTS = 5

_TERMINAL_CLAIM_STATE_KEYS = (
    TERMINAL_EVENT_STATE_KEY,
    TERMINAL_CLAIM_ID_STATE_KEY,
    TERMINAL_CLAIM_EXPIRES_STATE_KEY,
)
_TURN_TRANSIENT_STATE_KEYS = (
    ARTIFACT_SNAPSHOT_STATE_KEY,
    *_TERMINAL_CLAIM_STATE_KEYS,
    FOLLOW_UP_FAILURE_STATE_KEY,
)
_TERMINAL_SESSION_STATUSES = ("completed", "failed", "cancelled")


def finalization_retry_state(state: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Schedule the next finalization attempt with capped exponential backoff."""
    attempts = int(state.get(FINALIZATION_ATTEMPTS_STATE_KEY) or 0) + 1
    delay = min(
        FINALIZATION_RETRY_MAX_SECONDS,
        FINALIZATION_RETRY_BASE_SECONDS * 2 ** min(attempts - 1, FINALIZATION_RETRY_MAX_EXPONENT),
    )
    retry_at = (now + timedelta(seconds=delay)).isoformat()
    return {
        **state,
        FINALIZATION_ATTEMPTS_STATE_KEY: attempts,
        FINALIZATION_RETRY_AT_STATE_KEY: retry_at,
        RECOVERY_REQUIRED_STATE_KEY: attempts >= FINALIZATION_ESCALATION_ATTEMPTS,
        TERMINAL_CLAIM_EXPIRES_STATE_KEY: retry_at,
    }


def _without_keys(state: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: value for key, value in state.items() if key not in keys}


def _agent_label(assignment: dict[str, Any]) -> str:
    # Agent-first assignments carry agentId/executorKind and no "agent" key, so
    # indexing it raised before the request could be marked failed — leaving it
    # finalizing forever. Resolve the label the way scheduling.py does.
    return (
        assignment.get("agentDisplayName")
        or assignment.get("executorKind")
        or assignment.get("agent")
        or "Agent"
    )


def _turn_state_patch(event: dict[str, Any], agent_log: str, exit_code: Any) -> dict[str, Any]:
    return {
        "agent_logs": [agent_log],
        "last_exit_code": exit_code,
        "token_usage": event.get("tokenUsage"),
    }


def _agent_completed_payload(
    event: dict[str, Any],
    assignment: dict[str, Any],
    *,
    status: str,
    exit_code: Any,
    agent_log: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "runId": event["runId"],
        "agent": event["agent"],
        "status": status,
        "exitCode": exit_code,
        "agentLog": agent_log,
        **(details or {}),
        "tokenUsage": event.get("tokenUsage"),
        **({"runtimeSessionId": event["runtimeSessionId"]} if event.get("runtimeSessionId") else {}),
        "assignmentId": assignment.get("assignmentId"),
    }


def session_already_terminal(session: dict[str, Any]) -> bool:
    return bool(
        session.get("status") in _TERMINAL_SESSION_STATUSES
        or session.get("deletionRequestedAt")
    )


@dataclass(frozen=True)
class TurnFinalization:
    """What a terminal daemon event means for its request's current turn."""

    event: dict[str, Any]
    state: dict[str, Any]
    assignment: dict[str, Any]
    artifact_snapshot: Any
    already_recorded: bool


def decide_turn_finalization(
    run_request: dict[str, Any], event: dict[str, Any], session: dict[str, Any]
) -> TurnFinalization:
    already_recorded = any(
        item.get("type") == "agent.completed" and item.get("runId") == event["runId"]
        for item in session.get("events", [])
    )
    assignment = run_request["assignments"][run_request.get("currentIndex", 0)]
    raw_state = run_request["state"]
    state = _without_keys(dict(raw_state), _TURN_TRANSIENT_STATE_KEYS)
    if state.get("_relay_stop_command_id"):
        # Any terminal acknowledgement proves exit, but a late success
        # must not override the durable stop decision or start a successor.
        event = {**event, "type": "run.cancelled", "reason": run_request.get("error") or "Run stopped."}
    return TurnFinalization(
        event=event,
        state=state,
        assignment=assignment,
        artifact_snapshot=raw_state.get(ARTIFACT_SNAPSHOT_STATE_KEY),
        already_recorded=already_recorded,
    )


@dataclass(frozen=True)
class CompletedTurn:
    """How a completed (not failed/cancelled) turn's report should be applied."""

    succeeded: bool
    uses_work_protocol: bool
    work_result: Any
    round_result: dict[str, Any] | None
    rejected_reason: str | None


def decide_completed_turn(
    run_request: dict[str, Any],
    event: dict[str, Any],
    *,
    reports_round_result: bool,
    reported_round_result: dict[str, Any] | None,
) -> CompletedTurn:
    uses_work_protocol = bool((run_request.get("state") or {}).get(WORK_PROTOCOL))
    # An agent that asked its human and then exited badly still asked: the
    # question is the turn's result, and the exit code after it is noise
    # (a timeout, a runtime quirk). Failing the run would drop the question
    # the daemon already consumed and strand the task.
    succeeded = event["exitCode"] == 0 or (
        reports_round_result and is_question(reported_round_result)
    )
    work_result = None
    if uses_work_protocol and succeeded:
        envelope = event.get("roundResult")
        work_result = validate_work_result(envelope.get("work") if isinstance(envelope, dict) else None)
    # Exactly one assignment speaks for the whole round: the last writable
    # member. Earlier per-member verdicts are deliberately ignored.
    round_result = reported_round_result if succeeded and reports_round_result else None
    rejected = event.get("roundResultRejected")
    rejected_reason = (
        rejected["reason"]
        if reports_round_result
        and not round_result
        and isinstance(rejected, dict)
        and rejected.get("reason") in ROUND_RESULT_REJECTIONS
        else None
    )
    return CompletedTurn(
        succeeded=succeeded,
        uses_work_protocol=uses_work_protocol,
        work_result=work_result,
        round_result=round_result,
        rejected_reason=rejected_reason,
    )
