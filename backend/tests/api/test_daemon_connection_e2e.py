"""Daemon/server connection lifecycle over real loopback HTTP and durable stores."""
import time

import pytest

from daemon_e2e import DaemonE2E, eventually
from relay.daemon_registry import config


@pytest.fixture
def connection(tmp_path, monkeypatch):
    h = DaemonE2E(tmp_path, monkeypatch, daemon_options={
        "commandPollWaitMs": 1000, "commandLeaseSeconds": 3, "unreachableGraceMs": 10000,
    })
    try:
        h.setup()
        yield h
    finally:
        h.close()


def launches(h):
    return [item for item in h.traces() if item["kind"] == "launch"]


@pytest.mark.integration
@pytest.mark.parametrize("status", [429, 503])
def test_poll_failure_honors_retry_after_without_reregistering(connection, status):
    h = connection
    h.gate.fault = {"suffix": "/commands", "kind": "status", "status": status, "retry_after": 2}
    fault = eventually(lambda: next((entry for entry in h.gate.requests if entry.get("fault") == "status"), None))
    following = eventually(lambda: next((entry for entry in h.gate.requests
        if entry["path"].endswith("/commands") and entry["at"] > fault["at"]), None))
    assert following["at"] - fault["at"] >= 1.9
    assert len([item for item in h.traces() if item["kind"] == "registered"]) == 1
    task_id, session_id = h.start_task()
    h.settled(session_id, 1)
    assert h.client.get(f"/api/v1/tasks/{task_id}").json()["status"] == "done"


@pytest.mark.integration
def test_blackholed_poll_does_not_block_heartbeats_or_recovery(connection, monkeypatch):
    h = connection
    # Shorten only the server's observation windows to test stale admission
    # without spending a minute idle. Requests and timestamps remain real.
    monkeypatch.setattr(config, "COMMAND_POLL_MAX_WAIT_SECONDS", 1)
    monkeypatch.setattr(h.ctx.registry, "liveness_timeout_ms", 2000)
    h.gate.fault = {"suffix": "/commands", "kind": "hold", "remaining": 100}
    eventually(lambda: any(entry.get("fault") == "hold" for entry in h.gate.requests))
    beats = len([entry for entry in h.gate.requests if entry["path"].endswith("/heartbeat")])
    eventually(lambda: len([entry for entry in h.gate.requests if entry["path"].endswith("/heartbeat")]) >= beats + 4
        and not h.ctx.registry.is_dispatchable(h.node_id))
    node = next(node for node in h.ctx.registry.monitor_nodes() if node["id"] == h.node_id)
    assert node["online"] is True
    assert node["dispatchable"] is False
    assert h.process.poll() is None
    h.post("/daemon-node-registrations", {"sandboxId": h.node_id, "token": h.profile["token"],
        "protocolVersion": 2, "supportedAgents": ["codex"], "workspacePath": h.profile["workspace"],
        "workspaceId": h.profile["workspaceId"], "capabilities": node["capabilities"]}, 200)
    assert not h.ctx.registry.is_dispatchable(h.node_id)
    h.gate.fault = None
    eventually(lambda: h.ctx.registry.is_dispatchable(h.node_id))
    _, session_id = h.start_task()
    h.settled(session_id, 1)


@pytest.mark.integration
def test_lost_command_response_redelivers_without_duplicate_execution(connection):
    h = connection
    h.gate.fault = {"suffix": "/commands", "kind": "drop"}
    fault = eventually(lambda: next((entry for entry in h.gate.requests if entry.get("fault") == "drop"), None))
    _, session_id = h.start_task()
    eventually(lambda: fault.get("response_committed"))
    h.settled(session_id, 1)
    assert launches(h)[0]["commandId"] in [command["id"] for command in fault["response"].get("commands", [])], fault
    h.gate.fault = None
    assert len(launches(h)) == 1


@pytest.mark.integration
def test_server_restart_preserves_active_run_and_lease_recovery(connection):
    h = connection
    hold = h.root / "hold"
    hold.touch()
    task_id, session_id = h.start_task()
    eventually(lambda: launches(h))
    h.stop_server()
    # Exceed the three-second execution lease while remaining inside outage grace.
    time.sleep(4)
    assert h.process.poll() is None
    assert not any(item["kind"] == "runtime-ended" for item in h.traces())
    h.restart_server()
    eventually(lambda: any(item["kind"] == "connection-response" and item["status"] == 200
        and item["at"] > int((time.time() - 2) * 1000) for item in h.traces()))
    hold.unlink()
    h.settled(session_id, 1)
    assert h.client.get(f"/api/v1/tasks/{task_id}").json()["status"] == "done"
    h.follow_up(session_id)
    h.settled(session_id, 2)


@pytest.mark.integration
@pytest.mark.parametrize("revocation", ["token", "retirement"])
def test_authoritative_revocation_stops_daemon(connection, revocation):
    h = connection
    if revocation == "token":
        h.ctx.registry.reissue_node_token(h.node_id)
    else:
        h.ctx.registry.retire_deleted(h.node_id)
    eventually(lambda: h.process.poll() is not None)
    assert h.process.returncode == 0
    assert any(item["kind"] == "connection-response" and item["status"] == (401 if revocation == "token" else 410)
               for item in h.traces())
    assert not launches(h)


@pytest.mark.integration
def test_graceful_shutdown_drains_active_run_and_restart_accepts_work(connection):
    h = connection
    hold = h.root / "hold"
    hold.touch()
    _, session_id = h.start_task()
    eventually(lambda: launches(h))
    h.stop_daemon()
    assert h.ctx.registry.get(h.node_id)["status"] == "stopped"
    assert h.session(session_id)["status"] == "cancelled"
    assert any(item["kind"] == "runtime-ended" and item["aborted"] for item in h.traces())
    hold.unlink()
    h.start_daemon()
    eventually(lambda: len([item for item in h.traces() if item["kind"] == "registered"]) == 2)
    h.follow_up(session_id)
    h.settled(session_id, 2)


@pytest.mark.integration
@pytest.mark.parametrize("suffix,status", [("/commands", 403), ("/commands", 404), ("/heartbeat", 404)])
def test_proxy_refusal_or_old_heartbeat_route_recovers_by_registration(connection, suffix, status):
    h = connection
    h.gate.fault = {"suffix": suffix, "kind": "status", "status": status}
    eventually(lambda: any(entry.get("fault") == "status" for entry in h.gate.requests))
    eventually(lambda: len([item for item in h.traces() if item["kind"] == "registered"]) >= 2)
    assert h.process.poll() is None
    _, session_id = h.start_task()
    h.settled(session_id, 1)


@pytest.mark.integration
def test_revoked_token_stops_active_runtime_without_falsely_releasing_reservation(connection):
    h = connection
    (h.root / "hold").touch()
    task_id, session_id = h.start_task()
    eventually(lambda: launches(h))
    h.ctx.registry.reissue_node_token(h.node_id)
    eventually(lambda: h.process.poll() is not None)
    assert h.process.returncode == 0
    assert any(item["kind"] == "runtime-ended" and item["aborted"] for item in h.traces())
    # Revocation is not an authenticated daemon exit report. The server must
    # retain the execution reservation until exit evidence or human reconciliation.
    assert h.ctx.daemon_store.active_run_request_for_task(task_id) is not None
    assert h.session(session_id)["status"] != "completed"
