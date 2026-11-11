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
