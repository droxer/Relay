"""Independent workspaces must not queue behind runs that contend for one workspace."""
import pytest

from relay.daemon_registry.node_backend import ServerDaemonNodeBackend
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.persistence.daemon.store import DatabaseDaemonStore
from relay.persistence.session.store import DatabaseSessionStore
from relay.persistence.task.store import DatabaseTaskStore


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/state.db"
    sessions = DatabaseSessionStore(url, create_schema=True)
    tasks = DatabaseTaskStore(url, create_schema=True)
    daemon = DatabaseDaemonStore(url, create_schema=True)
    registry = DaemonNodeRegistry(sessions, daemon, task_store=tasks)
    payload = dict(sandboxId="node", userId="alice", token="token", workspacePath="/workspace",
                   protocolVersion=1, supportedAgents=["codex"],
                   capabilities=["workspace-scope", "thread-workspaces", "task-workspaces", "project-workspaces"],
                   status="ready", maxConcurrentRuns=3)
    registry.register(payload, "ui")
    monkeypatch.setattr(daemon, "claim_recovery_requests", lambda **kw: daemon.list_active_run_requests())
    return registry, payload


def terminal(command, kind="run.completed"):
    return dict(type=kind, commandId=command["id"], sessionId=command["sessionId"],
                runId=command["runId"], agent=command["agent"], leaseId=command["leaseId"], exitCode=0)


def start(registry, workspace, goal="work"):
    return ServerDaemonNodeBackend(registry)._run_sync("node", {
        "taskGoal": goal, "assignments": [{"agent": "codex"}],
        "workspaceLayout": "project", "workspaceSubpath": f"projects/{workspace}",
    })


def poll(registry):
    registry.reap_stale_runs()
    return registry.take_commands("node", "token", renew_known_active=False)


def finish(registry, command):
    registry.handle_event("node", terminal(command, "run.executing"), "token")
    registry.handle_event("node", terminal(command), "token")


def test_independent_workspace_starts_while_same_workspace_runs_wait(runtime):
    registry, _ = runtime
    a1 = start(registry, "a", "a1")
    [a1_command] = poll(registry)
    a2, a3 = start(registry, "a", "a2"), start(registry, "a", "a3")
    b1 = start(registry, "b", "b1")
    delivered = poll(registry)
    assert [c["sessionId"] for c in delivered] == [b1["id"]]
    assert {a2["id"], a3["id"]}.isdisjoint(c["sessionId"] for c in delivered)
    assert len(registry.daemon_store.list_active_runs()) == 2

    finish(registry, a1_command)
    [a2_command] = poll(registry)
    assert a2_command["sessionId"] == a2["id"]
    assert poll(registry) == []
    finish(registry, a2_command)
    [a3_command] = poll(registry)
    assert a3_command["sessionId"] == a3["id"]
    assert a1["id"] != a2["id"]


def test_waiting_workspace_runs_never_exceed_capacity(runtime):
    registry, _ = runtime
    for name in ("a", "b", "c"):
        start(registry, name)
    with pytest.raises(ValueError, match="capacity_exhausted"):
        start(registry, "d")
    assert len(registry.daemon_store.list_active_runs()) == 3
    start(registry, "a", "queued behind a")
    with pytest.raises(ValueError, match="capacity_exhausted"):
        for index in range(4):
            start(registry, "a", f"deferred {index}")
    assert len(registry.daemon_store.list_active_runs()) == 3
    assert len(registry.daemon_store.list_active_run_requests("node")) <= 6


def test_capacity_one_stays_serial_across_workspaces(runtime):
    registry, payload = runtime
    registry.register({**payload, "maxConcurrentRuns": 1}, "ui")
    first = start(registry, "a")
    [command] = poll(registry)
    assert command["sessionId"] == first["id"]
    with pytest.raises(ValueError, match="capacity_exhausted"):
        start(registry, "b")


def test_workspace_waiters_leave_admission_room_for_free_slots(runtime):
    registry, _ = runtime
    start(registry, "a", "holder")
    poll(registry)
    for index in range(3):
        start(registry, "a", f"waiter {index}")
    with pytest.raises(ValueError, match="capacity_exhausted"):
        start(registry, "a", "deferred queue overflow")
    independent = [start(registry, name) for name in ("b", "c")]
    assert {command["sessionId"] for command in poll(registry)} == {
        session["id"] for session in independent
    }


def test_cancelling_a_workspace_waiter_preserves_the_next_waiter(runtime):
    registry, _ = runtime
    start(registry, "a", "holder")
    [holder] = poll(registry)
    cancelled = start(registry, "a", "cancelled waiter")
    next_session = start(registry, "a", "next waiter")
    request = registry.daemon_store.active_run_request_for_session("node", cancelled["id"])
    assert registry.cancel_run_request_before_delivery(request["id"], "cancel waiter")
    assert poll(registry) == []
    finish(registry, holder)
    [next_command] = poll(registry)
    assert next_command["sessionId"] == next_session["id"]
    assert registry.daemon_store.get_run_request(request["id"])["status"] == "cancelled"
    assert len(registry.daemon_store.list_active_runs("node")) == 1


def test_dispatch_claim_rechecks_capacity_after_stale_admission(runtime):
    registry, payload = runtime
    registry.register({**payload, "maxConcurrentRuns": 1}, "ui")
    # Both replicas admitted while the slot was free. Admission is advisory;
    # only a durable dispatch claim may reserve the execution slot.
    store = registry.daemon_store
    sessions = [registry.store.create_session({
        "workspacePath": "/workspace", "taskGoal": f"stale-{index}",
    }) for index in range(2)]
    requests = [store.create_run_request({
        "nodeId": "node", "sessionId": session["id"], "taskGoal": "stale admission",
        "assignments": [{"agent": "codex"}], "state": {},
    }) for session in sessions]
    other = DatabaseDaemonStore(store.engine.url.render_as_string(hide_password=False))
    assert store.claim_run_request_dispatch(requests[0]["id"], "first", 30)
    assert other.claim_run_request_dispatch(requests[1]["id"], "second", 30) is None
    assert other.get_run_request(requests[1]["id"])["status"] == "running"
    store.update_run_request(requests[0]["id"], {"status": "cancelled"})
    assert other.claim_run_request_dispatch(requests[1]["id"], "retry", 30)


@pytest.mark.parametrize(
    ("same_agent", "second_runtime"),
    [(False, "codex"), (True, "codex"), (False, "claude")],
    ids=["same-runtime", "same-agent", "mixed-runtimes"],
)
def test_logical_agents_share_computer_capacity_across_independent_runs(
    runtime, tmp_path, same_agent, second_runtime
):
    from store_fixtures import make_agent_store, make_agent_placement_store
    from relay.agents.routing import resolve_agent_assignments

    registry, payload = runtime
    run_count = payload["maxConcurrentRuns"]
    if second_runtime == "claude":
        run_count = 4
        registry.register(
            {**payload, "supportedAgents": ["codex", "claude"], "maxConcurrentRuns": run_count},
            "ui",
        )
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    first = agents.create_agent("alice", {
        "displayName": "First", "executorKind": "codex", "defaultRole": "implementer",
    })
    second = first if same_agent else agents.create_agent("alice", {
        "displayName": "Second", "executorKind": second_runtime, "defaultRole": "implementer",
    })
    for agent in {a["id"]: a for a in (first, second)}.values():
        placements.create_placement(agent, "node")
    backend = ServerDaemonNodeBackend(registry, agent_store=agents, agent_placement_store=placements)
    selected_agents = (first, second, first, second)[:run_count]
    sessions = []
    task_ids = []
    for index, agent in enumerate(selected_agents):
        task = registry.task_store.create_task({
            "title": f"Independent task {index}", "ownerUserId": "alice", "status": "assigned",
        })
        task_ids.append(task["id"])
        assignments = resolve_agent_assignments(
            [{"agentId": agent["id"]}], user_id="alice", is_admin=False,
            agent_store=agents, placement_store=placements, daemon_nodes=registry.monitor_nodes(),
        )
        sessions.append(backend._run_sync("node", {
            "taskGoal": f"independent task {index}", "assignments": assignments,
            "taskId": task["id"],
            "actorUserId": "alice", "agentFirst": True,
        }))
    commands = poll(registry)
    assert [c["logicalAgentId"] for c in commands] == [agent["id"] for agent in selected_agents]
    assert {c["sessionId"] for c in commands} == {s["id"] for s in sessions}
    assert len({c["runId"] for c in commands}) == run_count
    assert {registry.daemon_store.run_request_for_command(c["id"])["taskId"] for c in commands} == set(task_ids)
    assert {c["workspaceSubpath"] for c in commands} == {f"tasks/{task_id}" for task_id in task_ids}
    assert [c["agent"] for c in commands] == [agent["executorKind"] for agent in selected_agents]
    assert len(registry.daemon_store.list_active_runs("node")) == run_count
    next_task = registry.task_store.create_task({
        "title": "Next task", "ownerUserId": "alice", "status": "assigned",
    })
    next_request = {
        "taskGoal": "next task", "assignments": assignments, "taskId": next_task["id"],
        "actorUserId": "alice", "agentFirst": True,
    }
    with pytest.raises(ValueError, match="capacity_exhausted"):
        backend._run_sync("node", next_request)
    # One run's cancellation settles only its own reservation and Thread.
    registry.handle_event("node", {**terminal(commands[0], "run.cancelled"), "reason": "cancel one"}, "token")
    assert {r["sessionId"] for r in registry.daemon_store.list_active_runs("node")} == {
        command["sessionId"] for command in commands[1:]
    }
    next_session = backend._run_sync("node", next_request)
    [next_command] = poll(registry)
    assert next_command["sessionId"] == next_session["id"]
    assert next_command["logicalAgentId"] == selected_agents[-1]["id"]
    assert len(registry.daemon_store.list_active_runs("node")) == run_count
    for command in [*commands[1:], next_command]:
        finish(registry, command)
    assert registry.daemon_store.list_active_runs("node") == []
