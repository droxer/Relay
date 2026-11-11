"""Runtime limits survive registration and fence dispatch across replicas."""
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.daemon_registry.node_backend import ServerDaemonNodeBackend
from relay.persistence.daemon.store import DatabaseDaemonStore
from relay.persistence.session.store import DatabaseSessionStore


def runtime(tmp_path):
    url = f"sqlite:///{tmp_path}/state.db"
    sessions = DatabaseSessionStore(url, create_schema=True)
    store = DatabaseDaemonStore(url, create_schema=True)
    registry = DaemonNodeRegistry(sessions, store)
    registry.register(dict(
        sandboxId="node", userId="alice", token="token", workspacePath="/workspace",
        protocolVersion=2, supportedAgents=["codex", "claude"],
        capabilities=["thread-workspaces", "workspace-scope"], maxConcurrentRuns=3,
        executorCapabilities=[dict(executorKind=name, status="ready", adapter="cli", maxConcurrentRuns=1)
                              for name in ("codex", "claude")],
    ), "ui")
    return registry, store, sessions, url


def start(registry, agent):
    return ServerDaemonNodeBackend(registry)._run_sync("node", {
        "taskGoal": "work", "assignments": [{"agent": agent}], "workspaceLayout": "thread",
    })


def test_runtime_wait_does_not_block_other_runtimes_and_resumes(tmp_path, monkeypatch):
    registry, store, _, url = runtime(tmp_path)
    monkeypatch.setattr(store, "claim_recovery_requests", lambda **kw: store.list_active_run_requests())
    first = start(registry, "codex")
    [command] = registry.take_commands("node", "token")
    waiting = start(registry, "codex")
    other = start(registry, "claude")
    assert [c["sessionId"] for c in registry.take_commands("node", "token")] == [other["id"]]
    assert registry.store.get_session(waiting["id"])["status"] == "running"
    # A fresh replica sees the same runtime capacity.
    fresh = DaemonNodeRegistry(registry.store, DatabaseDaemonStore(url))
    assert fresh.get("node")["agentDetails"]["codex"]["maxConcurrentRuns"] == 1
    registry.handle_event("node", dict(type="run.completed", commandId=command["id"],
        sessionId=first["id"], runId=command["runId"], agent="codex",
        leaseId=command["leaseId"], exitCode=0), "token")
    registry.reap_stale_runs()
    assert [c["sessionId"] for c in registry.take_commands("node", "token")] == [waiting["id"]]


def test_atomic_claim_rechecks_runtime_capacity(tmp_path):
    _, store, sessions, url = runtime(tmp_path)
    requests = [store.create_run_request(dict(nodeId="node", sessionId=sessions.create_session({
        "workspacePath": "/workspace", "taskGoal": "work",
    })["id"], taskGoal="work", assignments=[{"executorKind": agent}], state={}))
        for agent in ("codex", "codex", "claude")]
    other = DatabaseDaemonStore(url)
    assert store.claim_run_request_dispatch(requests[0]["id"], "a", 30)
    assert other.claim_run_request_dispatch(requests[1]["id"], "b", 30) is None
    assert other.claim_run_request_dispatch(requests[2]["id"], "c", 30)
    store.update_run_request(requests[0]["id"], {"status": "cancelled"})
    assert other.claim_run_request_dispatch(requests[1]["id"], "retry", 30)


def test_capacity_rejection_requeues_same_assignment_without_failure(tmp_path, monkeypatch):
    registry, store, _, _ = runtime(tmp_path)
    monkeypatch.setattr(store, "claim_recovery_requests", lambda **kw: store.list_active_run_requests())
    session = start(registry, "codex")
    [command] = registry.take_commands("node", "token")
    request = store.active_run_request_for_session("node", session["id"])
    event = dict(type="run.failed", commandId=command["id"], sessionId=session["id"],
                 runId=command["runId"], agent="codex", leaseId=command["leaseId"],
                 exitCode=1, error="Runtime is full", admissionRejected="runtime-capacity")
    registry.handle_event("node", event, "token")
    registry.handle_event("node", event, "token")  # Replay must not reset a new attempt.
    current = store.get_run_request(request["id"])
    assert current["status"] == "running"
    assert current["currentIndex"] == 0
    assert current.get("currentCommandId") is None
    assert registry.store.get_session(session["id"])["status"] == "running"
    registry.reap_stale_runs()
    [retried] = registry.take_commands("node", "token")
    assert retried["id"] != command["id"]
    assert retried["sessionId"] == session["id"]


def test_stop_wins_over_capacity_rejection(tmp_path):
    registry, store, _, _ = runtime(tmp_path)
    session = start(registry, "codex")
    [command] = registry.take_commands("node", "token")
    request = store.active_run_request_for_session("node", session["id"])
    registry.cancel_active_run("node", session["id"], "Stop requested", actor_user_id="alice")
    registry.handle_event("node", dict(type="run.failed", commandId=command["id"],
        sessionId=session["id"], runId=command["runId"], agent="codex", leaseId=command["leaseId"],
        error="Runtime full", admissionRejected="runtime-capacity"), "token")
    assert store.get_run_request(request["id"])["status"] == "cancelled"
    assert registry.store.get_session(session["id"])["status"] == "cancelled"


def test_runtime_capacity_defaults_and_validation():
    from relay.daemon_registry.records import agent_registration_state
    from relay.core.daemon_records import runtime_run_capacity
    for raw in (None, 0, -1, True, "2", 1.5):
        _, details = agent_registration_state({"executorCapabilities": [
            {"executorKind": "codex", "status": "ready", "maxConcurrentRuns": raw}]})
        assert runtime_run_capacity({"maxConcurrentRuns": 3, "agentDetails": details}, "codex") == 3
    assert runtime_run_capacity({"maxConcurrentRuns": 3, "agentDetails": {
        "codex": {"maxConcurrentRuns": 9}}}, "codex") == 3


def test_wire_only_accepts_known_admission_rejections():
    from relay.api.computers.daemon_events import RUN_PARSERS
    for raw in (None, "unknown", True, {}, []):
        assert "admissionRejected" not in RUN_PARSERS["run.failed"]({"admissionRejected": raw}, {"sessionId": "session", "runId": "run"})
    for reason in ("computer-capacity", "runtime-capacity"):
        assert RUN_PARSERS["run.failed"]({"admissionRejected": reason}, {"sessionId": "session", "runId": "run"})["admissionRejected"] == reason


def test_durable_rejection_replay_keeps_new_attempt_and_lease_fence(tmp_path, monkeypatch):
    import pytest
    from uuid import uuid4
    from relay.daemon_registry.records import CommandEventMismatchError

    registry, store, _, _ = runtime(tmp_path)
    monkeypatch.setattr(store, "claim_recovery_requests", lambda **kw: store.list_active_run_requests())
    session = start(registry, "codex")
    [command] = registry.take_commands("node", "token")
    event = dict(type="run.failed", commandId=command["id"], sessionId=session["id"],
                 runId=command["runId"], agent="codex", leaseId=command["leaseId"],
                 error="Runtime full", admissionRejected="runtime-capacity")
    report_id = str(uuid4())
    with pytest.raises(CommandEventMismatchError):
        registry.handle_durable_report("node", {**event, "leaseId": "wrong"}, "token", report_id, "digest")
    assert store.get_command(command["id"])["status"] == "dispatched"
    registry.handle_durable_report("node", event, "token", report_id, "digest")
    registry.reap_stale_runs()
    [retry] = registry.take_commands("node", "token")
    registry.handle_durable_report("node", event, "token", report_id, "digest")
    request = store.active_run_request_for_session("node", session["id"])
    assert request["currentCommandId"] == retry["id"]
    assert store.get_command(retry["id"])["status"] == "dispatched"
