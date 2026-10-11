"""A deletion a person asked for must never wait on nothing.

`execution_status` folds five inputs into one phase, and each earlier fix
covered the one combination someone hit. This walks the whole input space and
pins the liveness rule instead: once deletion was requested and the stop grace
has passed, either a person has a button (delete, report gone, retry save) or
Relay itself is still making progress on its own (undelivered work that the
delete cancels, or a finalization the reaper is still retrying).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from itertools import product

import pytest

from relay.persistence.daemon_store import (
    EXECUTION_INTERRUPTED_STATE_KEY, EXIT_UNCONFIRMED_STATE_KEY, TERMINAL_CLAIM_ID_STATE_KEY,
)
from relay.services.execution_lifecycle import STOP_GRACE_SECONDS, execution_status

NOW = datetime(2026, 10, 11, tzinfo=timezone.utc)
LONG_AGO = (NOW - timedelta(seconds=STOP_GRACE_SECONDS * 10)).isoformat()
JUST_NOW = (NOW - timedelta(seconds=1)).isoformat()
LIVE = (NOW + timedelta(seconds=30)).isoformat()
EXPIRED = (NOW - timedelta(seconds=30)).isoformat()

REQUEST_STATUSES = (None, "prepared", "dispatching", "running", "finalizing")
COMMAND_STATUSES = (None, "pending", "queued", "dispatched", "completed", "failed", "cancelled")
LEASES = (None, LIVE, EXPIRED, (NOW - timedelta(seconds=601)).isoformat())
EXECUTION_STATES = (None, EXECUTION_INTERRUPTED_STATE_KEY, EXIT_UNCONFIRMED_STATE_KEY)
STOPS = (None, JUST_NOW, LONG_AGO)
RECOVERY = (None, "finalization_failed", "missing_terminal_evidence", "unset_reason")
CLAIMS = (False, True)
RUNNING_AGENT = (False, True)
SESSION_STATUSES = ("running", "cancelled", "completed")


def _inputs():
    for (request_status, command_status, lease, stop, recovery, claim,
         running_agent, session_status, execution_state) in product(
        REQUEST_STATUSES, COMMAND_STATUSES, LEASES, STOPS, RECOVERY, CLAIMS,
        RUNNING_AGENT, SESSION_STATUSES, EXECUTION_STATES,
    ):
        if request_status is None and (stop or recovery or claim or execution_state):
            continue  # Flags live on the request; there is nowhere to put them.
        if command_status is None and lease:
            continue
        if (recovery or claim) and request_status != "finalizing":
            continue  # Only finalization claims and the reaper write these flags.
        if recovery and not claim:
            continue  # A request reaches finalizing recovery only through a claim.
        state: dict = {}
        if execution_state:
            state[execution_state] = LONG_AGO
        if stop:
            state.update({"_relay_stop_command_id": "cmd_stop", "_relay_stop_requested_at": stop})
        if recovery:
            state["_relay_recovery_required"] = True
            if recovery != "unset_reason":
                state["_relay_recovery_reason"] = recovery
        if claim:
            state[TERMINAL_CLAIM_ID_STATE_KEY] = "claim"
        request = {"status": request_status, "state": state} if request_status else None
        command = {"status": command_status, "leaseExpiresAt": lease} if command_status else None
        if request is None and command and command_status not in ("completed", "failed", "cancelled"):
            # status()/annotate() stand a live legacy command in as a running request.
            request = {"status": "running", "state": {}}
        session = {
            "id": "s", "status": session_status, "deletionRequestedAt": LONG_AGO,
            "hasRunningAgent": running_agent,
            "agentRuns": [{"id": "r", "status": "running"}] if running_agent else [],
        }
        yield session, request, command


def _self_resolving(status: dict) -> bool:
    # queued: finish_delete cancels undelivered work before it reads status
    # again. finalizing: the reaper keeps claiming finalization until it lands
    # or marks recovery_required, which then has its own button.
    return status["phase"] in ("queued", "finalizing")


def test_every_overdue_deletion_has_a_way_out() -> None:
    dead_ends = []
    for session, request, command in _inputs():
        status = execution_status(session, request, command, now=NOW, computer_online=False)
        if status["canDelete"] or status["canReportGone"] or status["canRetrySave"]:
            continue
        if _self_resolving(status):
            continue
        dead_ends.append((status["phase"], status["blockingReason"], request, command,
                          session["status"], session["hasRunningAgent"]))
    assert not dead_ends, f"{len(dead_ends)} dead ends, e.g. {dead_ends[:5]}"


def test_a_fresh_stop_still_gets_its_grace() -> None:
    """The escape must not fire early: a slow daemon is not a dead one."""
    session = {"id": "s", "status": "cancelled", "deletionRequestedAt": JUST_NOW, "agentRuns": []}
    request = {"status": "running", "state": {
        "_relay_stop_command_id": "cmd_stop", "_relay_stop_requested_at": JUST_NOW,
    }}
    for lease in (LIVE, EXPIRED):
        command = {"status": "dispatched", "leaseExpiresAt": lease}
        status = execution_status(session, request, command, now=NOW)
        assert status["canReportGone"] is False
        assert status["canDelete"] is False


def test_a_run_nobody_asked_to_stop_is_left_alone() -> None:
    """Without a stop or a deletion, an unresponsive run is not anyone's to assert gone."""
    session = {"id": "s", "status": "running", "agentRuns": []}
    request = {"status": "running", "state": {}}
    command = {"status": "dispatched", "leaseExpiresAt": EXPIRED}
    status = execution_status(session, request, command, now=NOW)
    assert status["phase"] == "unresponsive"
    assert status["canReportGone"] is False


@pytest.mark.parametrize("mark", ["2020-01-01T00:00:00", "not-a-date"])
@pytest.mark.parametrize("intent", ["stop", "delete"])
def test_invalid_stop_intent_timestamps_enter_recovery(mark: str, intent: str) -> None:
    session = {"id": "s", "status": "running", "agentRuns": []}
    state = {"_relay_stop_command_id": "cmd_stop"}
    if intent == "stop":
        state["_relay_stop_requested_at"] = mark
    else:
        session["deletionRequestedAt"] = mark
    status = execution_status(
        session, {"status": "running", "state": state},
        {"status": "dispatched", "leaseExpiresAt": LIVE}, now=NOW,
    )
    assert status["phase"] == "recovery_required"
    assert status["blockingReason"] == "termination_unconfirmed"
    assert status["canReportGone"] is True


@pytest.mark.parametrize("source", ["request", "command"])
def test_restored_evidence_overrides_a_stale_missing_evidence_flag(source: str) -> None:
    from relay.persistence.daemon_store import TERMINAL_EVENT_STATE_KEY

    state = {
        "_relay_recovery_required": True,
        "_relay_recovery_reason": "missing_terminal_evidence",
        TERMINAL_CLAIM_ID_STATE_KEY: "claim",
    }
    event = {"type": "run.completed", "exitCode": 0, "agentLog": "restored result"}
    command = {"status": "completed"}
    if source == "request":
        state[TERMINAL_EVENT_STATE_KEY] = event
    else:
        command["command"] = {"_terminalEvent": event}
    status = execution_status(
        {"id": "s", "status": "running", "agentRuns": []},
        {"status": "finalizing", "state": state}, command, now=NOW,
    )
    assert status["blockingReason"] == "finalization_failed"
    assert status["canReportGone"] is False
    assert status["canRetrySave"] is True
