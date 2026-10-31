"""A warm backend replica must respect another replica's committed state."""
import asyncio

import pytest

from relay.core.daemon_records import EXIT_UNCONFIRMED_STATE_KEY, NODE_POLL_DRAINED_AT
from relay.daemon_registry.node_backend import ServerDaemonNodeBackend
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.execution.lifecycle import ExecutionLifecycleService
from store_fixtures import make_auth_store, make_daemon_store, make_session_store
from user_ids import user_id

ALICE = user_id("alice")


@pytest.fixture
def replicas(tmp_path):
    make_auth_store(tmp_path).ensure_user("alice")
    sessions, daemon = make_session_store(tmp_path), make_daemon_store(tmp_path)
    first = DaemonNodeRegistry(sessions, daemon)
    payload = dict(sandboxId="node", userId=ALICE, token="token", workspacePath="/workspace",
                   protocolVersion=2, supportedAgents=["codex"], capabilities=["thread-workspaces"],
                   status="ready", maxConcurrentRuns=3)
    first.register(payload, "ui")
    second = DaemonNodeRegistry(make_session_store(tmp_path), make_daemon_store(tmp_path))
    return sessions, daemon, first, second, payload


def start(registry, **fields):
    session = asyncio.run(ServerDaemonNodeBackend(registry).run("node", {
        "taskGoal": "work", "assignments": [{"agent": "codex"}], **fields,
    }))
    [command] = registry.take_commands("node", "token", renew_known_active=False)
    return session, command


def test_warm_replica_never_delivers_work_after_drain(replicas):
    _, daemon, first, second, payload = replicas
    first.take_commands("node", "token")
    second.is_dispatchable("node")  # Warm its poll observation before the drain.
    first.heartbeat("node", "token", state="draining")
    daemon.enqueue_command("node", {"id": "refresh", "type": "runtime.refresh"})
    assert second.take_commands("node", "token") == []
    assert not second.is_dispatchable("node")
    assert daemon.get_node("node")["lastPollAt"] == NODE_POLL_DRAINED_AT
    first.register(payload, "ui")
    assert second.is_dispatchable("node")
    assert len(second.take_commands("node", "token")) == 1


@pytest.mark.parametrize("field,value", [
    ("disabledAgents", ["codex"]), ("agentRoleDefaults", {"codex": "reviewer"}),
    ("agentRoleOverrides", {"codex": "planner"}),
])
def test_registration_on_warm_replica_cannot_restore_cleared_setting(replicas, field, value):
    _, daemon, first, second, payload = replicas
    setter = {"disabledAgents": "set_disabled_agents", "agentRoleDefaults": "set_agent_role_defaults",
              "agentRoleOverrides": "set_agent_role_overrides"}[field]
    getattr(first, setter)("node", value)
    second.is_dispatchable("node")
    getattr(first, setter)("node", [] if isinstance(value, list) else {})
    second.register(payload, "ui")
    assert not daemon.get_node("node").get(field)


@pytest.mark.parametrize("event_type", ["run.output", "run.output.batch", "run.collaboration"])
def test_streamed_event_retries_are_deduplicated_across_warm_replicas(replicas, event_type):
    sessions, _, first, second, _ = replicas
    session, command = start(first)
    def event(sequence):
        fields = {"stream": "stdout", "text": str(sequence)}
        if event_type == "run.output.batch":
            fields = {"entries": [{**fields, "sequence": sequence}]}
        elif event_type == "run.collaboration":
            fields = {"collaboration": {"kind": "finding", "text": str(sequence)}}
        return dict(type=event_type, commandId=command["id"], sessionId=session["id"],
                    runId=command["runId"], agent="codex", leaseId=command["leaseId"],
                    sequence=sequence, **fields)
    first.handle_event("node", event(0), "token")
    second.handle_event("node", event(1), "token")
    first.handle_event("node", event(1), "token")
    second.handle_event("node", event(2), "token")
    first.handle_event("node", event(2), "token")
    stored_type = event_type.replace("run.", "agent.")
    events = [item for item in sessions.get_session(session["id"])["events"] if item["type"] == stored_type]
    assert len(events) == 3


def test_reconciliation_cannot_release_a_newer_execution(replicas, monkeypatch):
    _, daemon, first, second, _ = replicas
    session, old = start(first)
    request = daemon.active_run_request_for_session_any_node(session["id"])
    daemon.update_run_request(request["id"], {"state": {**request["state"], EXIT_UNCONFIRMED_STATE_KEY: True}})
    lifecycle = ExecutionLifecycleService(first, None)
    original = lifecycle.status
    replacement = []
    def status_after_another_replica_admits(snapshot):
        status = original(snapshot)
        if status["canReportGone"] and not replacement:
            second.handle_event("node", dict(type="run.cancelled", commandId=old["id"],
                sessionId=session["id"], runId=old["runId"], agent="codex", leaseId=old["leaseId"],
                reason="Old execution exited."), "token")
            # Same-thread interleaving models the race between the eligibility
            # observation and reconciliation's durable admission lock.
            new_session = ServerDaemonNodeBackend(second)._run_sync("node", {
                "taskGoal": "replacement", "sessionId": session["id"], "assignments": [{"agent": "codex"}],
            })
            assert new_session["id"] == session["id"]
            replacement.extend(second.take_commands("node", "token"))
        return status
    monkeypatch.setattr(lifecycle, "status", status_after_another_replica_admits)
    lifecycle.reconcile(session["id"], "alice")
    assert daemon.get_command(replacement[0]["id"])["status"] == "dispatched"
    assert daemon.active_run_request_for_session_any_node(session["id"]) is not None


def test_poll_cannot_overwrite_a_concurrent_drain(replicas, monkeypatch):
    _, daemon, first, second, _ = replicas
    first.take_commands("node", "token")
    second.is_dispatchable("node")
    daemon.enqueue_command("node", {"id": "refresh", "type": "runtime.refresh"})
    touch = second.daemon_store.mark_node_seen
    drained = False
    def drain_before_poll_write(*args, **kwargs):
        nonlocal drained
        if kwargs.get("polled") is True and not drained:
            drained = True
            first.heartbeat("node", "token", state="draining")
        return touch(*args, **kwargs)
    monkeypatch.setattr(second.daemon_store, "mark_node_seen", drain_before_poll_write)
    assert second.take_commands("node", "token") == []
    assert daemon.get_node("node")["lastPollAt"] == NODE_POLL_DRAINED_AT


def test_registration_preserves_setting_cleared_after_its_initial_read(replicas, monkeypatch):
    _, daemon, first, second, payload = replicas
    first.set_disabled_agents("node", ["codex"])
    register = second.daemon_store.register_node
    def clear_before_registration_write(node, **kwargs):
        first.set_disabled_agents("node", [])
        return register(node, **kwargs)
    monkeypatch.setattr(second.daemon_store, "register_node", clear_before_registration_write)
    observed = second.register(payload, "ui")
    assert not daemon.get_node("node").get("disabledAgents")
    assert not observed.get("disabledAgents")


def test_failed_stream_write_does_not_consume_its_durable_cursor(replicas, monkeypatch):
    sessions, daemon, first, second, _ = replicas
    session, command = start(first)
    append = sessions.append_event
    def fail_after_append(*args, **kwargs):
        append(*args, **kwargs)
        raise RuntimeError("injected output failure")
    event = dict(type="run.output", commandId=command["id"], sessionId=session["id"],
                 runId=command["runId"], agent="codex", leaseId=command["leaseId"],
                 stream="stdout", sequence=0, text="retained")
    monkeypatch.setattr(sessions, "append_event", fail_after_append)
    with pytest.raises(RuntimeError, match="injected output failure"):
        first.handle_event("node", event, "token")
    assert not [e for e in sessions.get_session(session["id"])["events"] if e["type"] == "agent.output"]
    assert not first.output_for_run(command["runId"])
    monkeypatch.setattr(sessions, "append_event", append)
    second.handle_event("node", event, "token")
    first.handle_event("node", event, "token")
    assert len([e for e in sessions.get_session(session["id"])["events"] if e["type"] == "agent.output"]) == 1
    assert daemon.get_command(command["id"])["command"]["_outputSequences"] == {"stdout": 0}


def test_reconciliation_rolls_back_its_assertion_when_command_write_fails(replicas, monkeypatch):
    sessions, daemon, first, _, _ = replicas
    session, command = start(first)
    request = daemon.active_run_request_for_session_any_node(session["id"])
    daemon.update_run_request(request["id"], {"state": {**request["state"], EXIT_UNCONFIRMED_STATE_KEY: True}})
    def fail(*args, **kwargs):
        raise RuntimeError("injected cancellation failure")
    monkeypatch.setattr(daemon, "mark_command_cancelled", fail)
    with pytest.raises(RuntimeError, match="injected cancellation failure"):
        ExecutionLifecycleService(first, None).reconcile(session["id"], "alice")
    assert not [e for e in sessions.get_session(session["id"])["events"] if e["type"] == "session.execution_reconciled"]
    assert daemon.get_command(command["id"])["status"] == "dispatched"
    assert daemon.active_run_request_for_session_any_node(session["id"]) is not None
