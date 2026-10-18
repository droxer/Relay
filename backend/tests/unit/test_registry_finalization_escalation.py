"""A finalization that keeps failing keeps retrying, but escalates to an error log."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from loguru import logger

from relay.daemon_registry import progression
from relay.daemon_registry.progression import (
    FINALIZATION_ESCALATION_ATTEMPTS,
    RunProgressionMixin,
    finalization_retry_state,
)
from relay.daemon_registry.records import TERMINAL_CLAIM_ID_STATE_KEY


class _FakeDaemonStore:
    def __init__(self, state: dict[str, Any]) -> None:
        self.request = {"id": "req_1", "state": state}
        self.updates: list[dict[str, Any]] = []

    def claim_terminal_run_request(self, *_args: Any) -> dict[str, Any]:
        return self.request

    def update_run_request_if_claimed(self, request_id, key, claim_id, patch):
        assert (request_id, key, claim_id) == ("req_1", TERMINAL_CLAIM_ID_STATE_KEY, "claim_1")
        self.updates.append(patch)
        self.request = {**self.request, **patch}
        return self.request


def _failing_registry(prior_attempts: int) -> SimpleNamespace:
    store = _FakeDaemonStore({
        TERMINAL_CLAIM_ID_STATE_KEY: "claim_1",
        "_relay_finalization_attempts": prior_attempts,
    })

    def broken(*_args: Any) -> None:
        raise RuntimeError("persistent storage failure")

    return SimpleNamespace(daemon_store=store, _advance_run_request=broken)


def _finalize(registry: SimpleNamespace) -> list[str]:
    errors: list[str] = []
    sink = logger.add(lambda message: errors.append(message.record["extra"]), level="ERROR")
    try:
        with pytest.raises(RuntimeError, match="persistent storage failure"):
            RunProgressionMixin._claim_and_advance_run_request(
                registry, {"commandId": "cmd_1"}
            )
    finally:
        logger.remove(sink)
    return errors


def test_escalation_threshold_is_named_and_matches_recovery_flag():
    assert progression.FINALIZATION_ESCALATION_ATTEMPTS == 5
    below = finalization_retry_state({"_relay_finalization_attempts": 3}, datetime.now(UTC))
    at = finalization_retry_state({"_relay_finalization_attempts": 4}, datetime.now(UTC))
    assert below["_relay_recovery_required"] is False
    assert at["_relay_recovery_required"] is True


def test_backoff_is_capped_at_five_minutes():
    now = datetime(2026, 1, 1, tzinfo=UTC)
    state = finalization_retry_state({"_relay_finalization_attempts": 40}, now)
    assert state["_relay_finalization_retry_at"] == "2026-01-01T00:05:00+00:00"
    assert state["_relay_terminal_claim_expires_at"] == state["_relay_finalization_retry_at"]


def test_failures_below_threshold_retry_without_error_log():
    registry = _failing_registry(FINALIZATION_ESCALATION_ATTEMPTS - 2)
    errors = _finalize(registry)
    assert errors == []
    state = registry.daemon_store.updates[-1]["state"]
    assert state["_relay_finalization_attempts"] == FINALIZATION_ESCALATION_ATTEMPTS - 1


@pytest.mark.parametrize("prior_attempts", [FINALIZATION_ESCALATION_ATTEMPTS - 1, 50])
def test_failures_at_threshold_log_error_and_keep_retrying(prior_attempts):
    registry = _failing_registry(prior_attempts)
    errors = _finalize(registry)
    assert len(errors) == 1
    assert errors[0]["attempts"] == prior_attempts + 1
    assert errors[0]["request_id"] == "req_1"
    assert errors[0]["command_id"] == "cmd_1"
    # Still retrying: the claim is rescheduled, never failed or released.
    patch = registry.daemon_store.updates[-1]
    assert set(patch) == {"state"}
    assert patch["state"]["_relay_finalization_attempts"] == prior_attempts + 1
    assert patch["state"][TERMINAL_CLAIM_ID_STATE_KEY] == "claim_1"
    assert patch["state"]["_relay_recovery_required"] is True
