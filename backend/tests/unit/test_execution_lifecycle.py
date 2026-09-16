from datetime import datetime, timezone

import pytest

from relay.services.execution_lifecycle import ExecutionLifecycleService, execution_status

NOW = datetime(2026, 9, 16, tzinfo=timezone.utc)


@pytest.mark.parametrize("run_request,command,phase", [
    (None, None, "terminal"),
    ({"status": "prepared"}, None, "queued"),
    ({"status": "running"}, {"status": "queued"}, "queued"),
    ({"status": "running"}, {"status": "dispatched", "leaseExpiresAt": "2026-09-17T00:00:00Z"}, "running"),
    ({"status": "running"}, {"status": "dispatched", "leaseExpiresAt": "2026-09-15T00:00:00Z"}, "unresponsive"),
    ({"status": "running"}, {"status": "dispatched", "leaseExpiresAt": "invalid"}, "unresponsive"),
    ({"status": "running", "state": {"_relay_stop_command_id": "stop"}}, {"status": "dispatched", "leaseExpiresAt": "2026-09-17T00:00:00Z"}, "stopping"),
    ({"status": "finalizing"}, {"status": "completed"}, "finalizing"),
    ({"status": "finalizing", "state": {"_relay_recovery_required": True}}, {"status": "failed"}, "recovery_required"),
])
def test_execution_truth_does_not_trust_session_outcome(run_request, command, phase):
    status = execution_status({"status": "completed", "agentRuns": []}, run_request, command, now=NOW)
    assert status["phase"] == phase
    assert status["canDelete"] == (phase == "terminal")
    assert status["executionConfirmed"] == (phase in {"running", "stopping"})


def test_orphaned_agent_record_requires_recovery():
    result = execution_status({"status": "failed", "agentRuns": [{"status": "running"}]}, None, None)
    assert result["blockingReason"] == "orphaned_run"
    assert result["canDelete"] is False


def test_recovery_runs_without_browser_traffic_and_stops_cleanly():
    import asyncio
    asyncio.run(_background_recovery())


async def _background_recovery():
    import asyncio
    from types import SimpleNamespace
    ticks = []
    def pending(**kw):
        if len(ticks) == 1:
            raise RuntimeError("temporary database outage")
        return []
    registry = SimpleNamespace(
        reap_stale_runs=lambda: ticks.append(True),
        store=SimpleNamespace(list_pending_deletions=pending),
    )
    service = ExecutionLifecycleService(registry, None, interval_seconds=0.01)
    service.start()
    for _ in range(100):
        if len(ticks) >= 2:
            break
        await asyncio.sleep(0.01)
    await service.stop()
    assert len(ticks) >= 2
    count = len(ticks)
    await asyncio.sleep(0.03)
    assert len(ticks) == count


def test_stopping_does_not_remain_silent_forever():
    status = execution_status({}, {"status": "running", "state": {
        "_relay_stop_command_id": "stop", "_relay_stop_requested_at": "2026-09-15T00:00:00Z",
    }}, {"status": "dispatched", "leaseExpiresAt": "2026-09-17T00:00:00Z"}, now=NOW)
    assert status["phase"] == "recovery_required"
    assert status["blockingReason"] == "termination_unconfirmed"
    assert status["canDelete"] is False
