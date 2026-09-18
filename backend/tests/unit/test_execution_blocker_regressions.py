"""Execution ownership and recovery across admission and delivery failures."""
import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from relay.daemon_registry import DaemonNodeRegistry, ServerDaemonNodeBackend
from relay.persistence.daemon_store import DatabaseDaemonStore, LocalDaemonStore
from relay.persistence.session_store import DatabaseSessionStore, LocalSessionStore
from relay.persistence.task_store import DatabaseTaskStore, LocalTaskStore


@pytest.fixture(params=["local", "database"])
def runtime(tmp_path, request, monkeypatch):
    url = f"sqlite:///{tmp_path}/state.db"
    database = request.param == "database"
    sessions = DatabaseSessionStore(url, create_schema=True) if database else LocalSessionStore(tmp_path)
    tasks = DatabaseTaskStore(url, create_schema=True) if database else LocalTaskStore(tmp_path)
    daemon = DatabaseDaemonStore(url, create_schema=True) if database else LocalDaemonStore(tmp_path)
    registry = DaemonNodeRegistry(sessions, daemon, task_store=tasks)
    payload = dict(sandboxId="node", employeeId="alice", token="token", workspacePath="/workspace",
                   protocolVersion=1, supportedAgents=["codex"], capabilities=["thread-workspaces", "task-workspaces"],
                   status="ready", maxConcurrentRuns=10)
    registry.register(payload, "ui")
    if database:
        # Test recovery transitions without the independent batch-claim cooldown.
        monkeypatch.setattr(daemon, "claim_recovery_requests", lambda **kw: daemon.list_active_run_requests())
    return sessions, tasks, registry, payload


def terminal(command):
    return dict(type="run.completed", commandId=command["id"], sessionId=command["sessionId"],
                runId=command["runId"], agent=command["agent"], leaseId=command["leaseId"], exitCode=0)


def expire_leases(monkeypatch):
    future = (datetime.now(UTC) + timedelta(seconds=120)).isoformat()
    monkeypatch.setattr("relay.persistence.daemon_store.now_iso", lambda: future)


def test_expired_run_keeps_lease_and_accepts_saved_terminal(runtime, monkeypatch):
    async def scenario():
        sessions, tasks, registry, _ = runtime
        backend = ServerDaemonNodeBackend(registry)
        session = await backend.run("node", {"taskGoal": "retain ownership", "assignments": [{"agent": "codex"}]})
        [command] = registry.take_commands("node", "token", renew_known_active=False)
        expire_leases(monkeypatch)
        assert registry.take_commands("node", "token", renew_known_active=False) == []
        assert registry.available_command_count("node", "token") == 0
        assert registry.daemon_store.get_command(command["id"])["leaseId"] == command["leaseId"]
        registry.handle_event("node", terminal(command), "token")
        assert sessions.get_session(session["id"])["status"] == "completed"
        assert registry.daemon_store.list_active_runs() == []
    asyncio.run(scenario())


def test_expired_starts_do_not_starve_cancellation_page(runtime, monkeypatch):
    async def scenario():
        _, _, registry, _ = runtime
        backend = ServerDaemonNodeBackend(registry)
        for index in range(10):
            await backend.run("node", {"taskGoal": str(index), "assignments": [{"agent": "codex"}]})
        commands = registry.take_commands("node", "token", limit=10, renew_known_active=False)
        for command in commands:
            registry.cancel_active_run("node", command["sessionId"], "stop")
        expire_leases(monkeypatch)
        cancels = registry.take_commands("node", "token", limit=10, renew_known_active=False)
        assert len(cancels) == 10
        assert {c["commandId"] for c in cancels} == {c["id"] for c in commands}
        assert all(c["type"] == "run.cancel" for c in cancels)
        # Cancellation delivery itself is not exit evidence.
        assert len(registry.daemon_store.list_active_runs()) == 10
    asyncio.run(scenario())


def test_capacity_loss_queues_only_the_undelivered_assignment(runtime):
    async def scenario():
        sessions, tasks, registry, payload = runtime
        backend = ServerDaemonNodeBackend(registry)
        task = tasks.create_task({"title": "two steps"})
        first = await backend.run("node", {"taskGoal": "first", "taskId": task["id"],
                                           "assignments": [{"agent": "codex"}, {"agent": "codex"}]})
        second = await backend.run("node", {"taskGoal": "second", "assignments": [{"agent": "codex"}]})
        commands = registry.take_commands("node", "token")
        a = next(c for c in commands if c["sessionId"] == first["id"])
        b = next(c for c in commands if c["sessionId"] == second["id"])
        registry.register({**payload, "maxConcurrentRuns": 1}, "ui")
        registry.handle_event("node", terminal(a), "token")
        request = registry.daemon_store.active_run_request_for_task(task["id"])
        assert request is not None
        assert request["currentIndex"] == 1
        assert not request.get("currentCommandId")
        assert tasks.get_task(task["id"])["status"] != "blocked"
        assert registry.take_commands("node", "token") == []
        registry.handle_event("node", terminal(b), "token")
        registry.reap_stale_runs()
        [next_command] = registry.take_commands("node", "token")
        assert next_command["sessionId"] == first["id"]
        assert next_command["runId"] != a["runId"]
        registry.handle_event("node", terminal(next_command), "token")
        assert sessions.get_session(first["id"])["status"] == "completed"
        assert len(sessions.get_session(first["id"])["agentRuns"]) == 2
    asyncio.run(scenario())


def test_failed_task_projection_recovers_after_storage_error(runtime, monkeypatch):
    async def scenario():
        sessions, tasks, registry, _ = runtime
        task = tasks.create_task({"title": "recover blocker"})
        session = await ServerDaemonNodeBackend(registry).run("node", {
            "taskGoal": "projection", "taskId": task["id"], "assignments": [{"agent": "codex"}, {"agent": "codex"}],
        })
        [command] = registry.take_commands("node", "token")
        registry.set_disabled_agents("node", ["codex"])
        append = tasks.append_event
        def fail_block(task_id, event, **kwargs):
            if event["type"] == "task.status" and event.get("status") == "blocked":
                raise RuntimeError("injected blocker write failure")
            return append(task_id, event, **kwargs)
        monkeypatch.setattr(tasks, "append_event", fail_block)
        with pytest.raises(RuntimeError, match="blocker write"):
            registry.handle_event("node", terminal(command), "token")
        monkeypatch.setattr(tasks, "append_event", append)
        registry.reap_stale_runs()
        assert sessions.get_session(session["id"])["status"] == "failed"
        assert tasks.get_task(task["id"])["status"] == "blocked"
        assert "disabled" in tasks.get_task(task["id"])["blockerReason"]
        assert not registry.daemon_store.active_run_request_for_task(task["id"])
        before = tasks.get_task(task["id"])
        registry.reap_stale_runs()
        assert tasks.get_task(task["id"]) == before
    asyncio.run(scenario())
