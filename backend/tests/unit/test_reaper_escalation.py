"""A run whose reaping keeps failing is escalated, never released."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from loguru import logger

from relay.daemon_registry import reaper
from relay.daemon_registry.registry import DaemonNodeRegistry
from store_fixtures import make_daemon_store
from store_fixtures import make_session_store


@pytest.fixture
def error_logs():
    records: list[dict[str, Any]] = []
    sink_id = logger.add(
        lambda message: records.append(message.record), level="ERROR", format="{message}"
    )
    yield records
    logger.remove(sink_id)


def escalations(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [r for r in records if r["message"].startswith("Run reaping keeps failing")]


def poisoned_registry(root: Path) -> tuple[DaemonNodeRegistry, dict[str, Any]]:
    daemon_store = make_daemon_store(str(root))
    daemon_store.register_node({
        "id": "sbx_missing", "userId": "alice", "status": "ready", "agents": {},
        "createdAt": "2026-06-13T00:00:00.000Z", "updatedAt": "2026-06-13T00:00:00.000Z",
    })
    # The session this request names does not exist, so every reap pass raises.
    request = daemon_store.create_run_request({
        "nodeId": "sbx_missing", "sessionId": "session-that-is-gone",
        "taskGoal": "poisoned", "assignments": [{"executorKind": "codex", "mode": "action"}],
        "state": {}, "status": "running",
    })
    # Each pass leases what it recovers; a zero lease lets back-to-back
    # passes in one test see the same request again.
    claim = daemon_store.claim_recovery_requests
    daemon_store.claim_recovery_requests = lambda **kwargs: claim(**{**kwargs, "lease_seconds": 0})  # type: ignore[method-assign]
    return DaemonNodeRegistry(make_session_store(str(root)), daemon_store), request


def test_consecutive_reap_failures_escalate_at_the_threshold_and_keep_the_run(
    tmp_path: Path, error_logs: list[dict[str, Any]]
) -> None:
    registry, request = poisoned_registry(tmp_path)
    threshold = reaper.REAP_FAILURE_ESCALATION_THRESHOLD

    for _ in range(threshold - 1):
        registry.reap_stale_runs(force=True)
    assert escalations(error_logs) == []

    registry.reap_stale_runs(force=True)
    [escalation] = escalations(error_logs)
    assert escalation["extra"]["consecutive_failures"] == threshold
    assert escalation["extra"]["run_request_id"] == request["id"]
    # Reaping failing is not exit evidence: the reservation is untouched.
    assert registry.daemon_store.get_run_request(request["id"])["status"] == "running"


def test_a_successful_reap_clears_the_failure_count(
    tmp_path: Path, error_logs: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    registry, request = poisoned_registry(tmp_path)
    threshold = reaper.REAP_FAILURE_ESCALATION_THRESHOLD
    key = f"request:{request['id']}"

    for _ in range(threshold - 1):
        registry.reap_stale_runs(force=True)
    assert registry._reap_failures[key] == threshold - 1

    healthy = registry._recover_run_request_steps
    monkeypatch.setattr(registry, "_recover_run_request_steps", lambda _request: None)
    registry.reap_stale_runs(force=True)
    assert key not in registry._reap_failures

    monkeypatch.setattr(registry, "_recover_run_request_steps", healthy)
    for _ in range(threshold - 1):
        registry.reap_stale_runs(force=True)
    assert escalations(error_logs) == []


def test_a_finalization_failure_logged_in_place_still_counts(tmp_path: Path) -> None:
    registry, request = poisoned_registry(tmp_path)

    def failing_finalize(_request: dict[str, Any]) -> None:
        raise reaper._LoggedReapFailure

    registry._recover_run_request_steps = failing_finalize  # type: ignore[method-assign]
    registry.reap_stale_runs(force=True)
    registry.reap_stale_runs(force=True)
    assert registry._reap_failures[f"request:{request['id']}"] == 2


def test_failure_tracking_is_bounded_and_forgets_the_least_recent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(reaper, "REAP_FAILURE_TRACKING_LIMIT", 3)
    registry, _ = poisoned_registry(tmp_path)

    for key in ("a", "b", "c", "a", "d"):
        registry._note_reap_failure(key)

    # "b" failed least recently once "a" failed again, so it is dropped.
    assert list(registry._reap_failures) == ["c", "a", "d"]
    assert registry._reap_failures["a"] == 2
    assert len(registry._reap_failures) == 3
