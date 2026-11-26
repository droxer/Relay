"""Task starts recover from unavailable projects and idle precreated threads."""

import asyncio

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.sessions.controller import SessionController

from automation_helpers import WEEKLY_TRIGGERS
from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer
from user_ids import user_id

ALICE = user_id("alice")


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice", "machine-a")
    app.state.registry.update_status(node["id"], {"capabilities": [*node["capabilities"], "task-workspaces"]})
    agent = _agent(client, app, node, "Builder", "codex")
    _login_alice(client)
    response = client.post(
        "/api/v1/projects",
        json={
            "name": "Recoverable project",
            "daemonNodeId": node["id"],
            "leadAgentId": agent["id"],
            "members": [
                {
                    "agentId": agent["id"],
                    "role": "implementer",
                    "responsibilities": "Deliver work",
                }
            ],
        },
    )
    assert response.status_code == 201, response.text
    return app, client, node, agent, response.json()["project"]


@pytest.mark.parametrize("failure", ["computer", "executor"])
def test_queued_project_start_retries_when_runtime_recovers(setup, failure):
    app, client, node, _, project = setup
    task = client.post(
        "/api/v1/tasks",
        json={
            "title": "Recover project start",
            "projectId": project["id"],
        },
    ).json()
    patch = (
        {"status": "failed"}
        if failure == "computer"
        else {"agents": {"codex": "unavailable"}}
    )
    app.state.registry.update_status(node["id"], patch)
    result = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert result.status_code == 202, result.text
    assert result.json()["dispatch"]["state"] == "queued"
    assert result.json()["dispatch"]["code"] == (
        "project_computer_offline" if failure == "computer" else "agent_offline"
    )
    assert result.json()["task"]["status"] == "assigned"
    _register_computer(app, node["id"], "machine-a")
    assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 1
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert command["workspaceSubpath"] == project["workspaceSubpath"]


@pytest.mark.parametrize("scope", ["agent", "project"])
def test_precreated_idle_thread_can_start_without_duplicate_execution(setup, scope):
    app, client, node, agent, project = setup
    if scope == "agent":
        task = app.state.task_store.create_task({
            "title": "Start precreated thread",
            "sourceRoutineId": "routine_nightly",
            "ownerUserId": ALICE,
            "assigneeUserId": ALICE,
            "assignedAgentId": agent["id"],
            "assignedAgent": agent["executorKind"],
        })
        controller = SessionController(
            app.state.session_store, task_store=app.state.task_store,
            task_id=task["id"], owner_user_id=ALICE, owner_agent_id=agent["id"],
        )
        controller.create_session(task["title"], ["human", "codex"])
        task = app.state.task_store.get_task(task["id"])
    else:
        response = client.post("/api/v1/tasks", json={
            "title": "Start precreated thread", "createSession": True,
            "projectId": project["id"],
        })
        assert response.status_code == 201, response.text
        task = response.json()
    [original_session_id] = task["linkedSessionIds"]
    assert not app.state.daemon_store.active_run_request_for_task(task["id"])
    result = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert result.status_code == 202, result.text
    assert result.json()["dispatch"]["state"] == "started", result.json()
    again = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert again.json()["dispatch"]["code"] == "task_execution_active"
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert command["type"] == "run.start"
    binding = app.state.task_store.get_task(task["id"])["workspaceBinding"]
    assert binding["computerId"] == computer_id(node)
    assert "unbound" not in binding
    assert command["sessionId"] == original_session_id
    assert app.state.session_store.get_session(original_session_id)


@pytest.mark.parametrize("scope", ["agent", "project", "routine"])
def test_explicit_start_retries_blocked_dispatch_without_automatic_retry(setup, monkeypatch, scope):
    app, client, node, agent, project = setup
    assignment = {"projectId": project["id"]} if scope == "project" else {"assignedAgentId": agent["id"], "projectId": project["id"]}
    if scope == "routine":
        assignment.pop("projectId", None)
        assignment.update(computerId=computer_id(node), isRoutine=True, routineState="active", routineTriggers=WEEKLY_TRIGGERS)
    created = client.post("/api/v1/tasks", json={"title": "Retry failed work", **assignment})
    assert created.status_code == 201, created.text
    task = created.json()
    original_run = app.state.backend.run

    async def unavailable(*args, **kwargs):
        raise ValueError("capacity_exhausted: fixture computer is full")

    monkeypatch.setattr(app.state.backend, "run", unavailable)
    failed = client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).json()
    assert failed["task"]["status"] == "blocked", failed
    failed_id = failed["task"]["id"]
    monkeypatch.setattr(app.state.backend, "run", original_run)
    assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 0
    assert app.state.task_store.get_task(failed_id)["status"] == "blocked"

    retried = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert retried.status_code == 202, retried.text
    result = retried.json()
    assert result["dispatch"]["state"] == "started", result
    if scope == "routine":
        # Run now is a fresh capped firing once an occurrence is parked in
        # blocked; failed history remains on the previous ledger row.
        assert result["task"]["id"] != failed_id
        assert result["task"]["routineTriggerKind"] == "manual"
    else:
        assert result["task"]["id"] == failed_id
    assert not result["task"].get("blockerReason")
    again = client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).json()
    assert again["dispatch"]["code"] == (
        "already_started" if scope == "routine" else "task_execution_active"
    ), again
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert len([command for command in commands if command["type"] == "run.start"]) == 1


def test_explicit_start_does_not_unblock_owned_execution(setup):
    app, client, node, agent, project = setup
    task = client.post("/api/v1/tasks", json={"title": "Already admitted", "projectId": project["id"], "assignedAgentId": agent["id"]}).json()
    started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).json()
    assert started["dispatch"]["state"] == "started", started
    app.state.task_store.update_task(task["id"], {"status": "blocked", "blockerReason": "Waiting for reconciliation"})
    result = client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).json()
    assert result["dispatch"]["code"] == "task_execution_active", result
    assert result["task"]["status"] == "blocked"
    assert result["task"]["blockerReason"] == "Waiting for reconciliation"
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert len([command for command in commands if command["type"] == "run.start"]) == 1


@pytest.mark.parametrize("trigger", ["manual", "scheduler"])
def test_unblock_reuses_precreated_project_thread(setup, monkeypatch, trigger):
    app, client, node, agent, project = setup
    created = client.post("/api/v1/tasks", json={
        "title": "Unblock without duplicating the thread",
        "projectId": project["id"],
        "createSession": True,
        "assignedAgentId": agent["id"],
    })
    assert created.status_code == 201, created.text
    task = created.json()
    [session_id] = task["linkedSessionIds"]
    original_run = app.state.backend.run

    async def unavailable(*args, **kwargs):
        raise ValueError("capacity_exhausted: fixture computer is full")

    monkeypatch.setattr(app.state.backend, "run", unavailable)
    failed = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert failed.status_code == 202, failed.text
    assert failed.json()["task"]["status"] == "blocked"
    monkeypatch.setattr(app.state.backend, "run", original_run)
    unblocked = client.patch(f"/api/v1/tasks/{task['id']}", json={"action": "unblock"})
    assert unblocked.status_code == 200, unblocked.text
    if trigger == "manual":
        retried = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert retried.status_code == 202, retried.text
        assert retried.json()["dispatch"]["state"] == "started", retried.json()
    else:
        assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 1
    assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 0
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    [command] = [command for command in commands if command["type"] == "run.start"]
    assert command["sessionId"] == session_id
    assert app.state.task_store.get_task(task["id"])["linkedSessionIds"] == [session_id]


@pytest.mark.parametrize("trigger", ["retry", "retry_executed", "unblock_manual", "unblock_scheduler"])
def test_failed_admitted_task_reuses_original_thread(setup, trigger):
    app, client, node, agent, project = setup
    task = client.post("/api/v1/tasks", json={
        "title": "Retry the admitted task in its original thread",
        "projectId": project["id"], "assignedAgentId": agent["id"],
    }).json()
    started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert started.status_code == 202, started.text
    assert started.json()["dispatch"]["state"] == "started", started.text
    session_id = started.json()["session"]["id"]
    binding = app.state.task_store.get_task(task["id"])["workspaceBinding"]
    token = f"token_{node['id']}"
    [command] = app.state.registry.take_commands(node["id"], token)
    event_fields = {
        "commandId": command["id"],
        "leaseId": command["leaseId"], "sessionId": session_id,
        "runId": command["runId"], "agent": command["agent"],
    }
    if trigger == "retry_executed":
        app.state.registry.handle_event(node["id"], {
            "type": "run.executing", **event_fields,
        }, token)
    app.state.registry.handle_event(node["id"], {
        "type": "run.failed", **event_fields,
        "exitCode": 1, "error": "Agent failed",
    }, token)
    assert app.state.task_store.get_task(task["id"])["status"] == "blocked"
    if trigger.startswith("unblock"):
        unblocked = client.patch(f"/api/v1/tasks/{task['id']}", json={"action": "unblock"})
        assert unblocked.status_code == 200, unblocked.text
    if trigger == "unblock_scheduler":
        assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 1
    else:
        retried = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert retried.status_code == 202, retried.text
        assert retried.json()["dispatch"]["state"] == "started", retried.text
    [retried_command] = app.state.registry.take_commands(node["id"], token)
    assert retried_command["sessionId"] == session_id
    current = app.state.task_store.get_task(task["id"])
    assert current["linkedSessionIds"] == [session_id]
    assert current["workspaceBinding"] == binding


@pytest.mark.parametrize("project_task", [False, True])
def test_owner_can_complete_every_task_status(setup, project_task):
    app, client, node, agent, project = setup
    placement = {"projectId": project["id"]} if project_task else {"computerId": computer_id(node)}
    other = TestClient(app)
    for status in ("backlog", "assigned", "queued", "running", "waiting_for_human",
                   "blocked", "cancelled", "review", "done"):
        response = client.post("/api/v1/tasks", json={
            "title": f"Complete from {status}", "assignedAgentId": agent["id"], **placement,
        })
        assert response.status_code == 201, response.text
        task_id = response.json()["id"]
        app.state.task_store.update_task(task_id, {"status": status})
        url = f"/api/v1/tasks/{task_id}"
        assert other.patch(url, json={"status": "done"}).status_code == 401
        if status == "backlog":
            assert other.post("/api/v1/auth/login", json={
                "username": "admin", "password": "kestrel-vault-7719",
            }).status_code == 200
            assert other.patch(url, json={"status": "done"}).status_code == 403
            assert other.post("/api/v1/auth/logout").status_code == 200
        result = client.patch(url, json={"status": "done"})
        assert result.status_code == 200, result.text
        task = result.json()
        assert task["workflowStage"] == task["status"] == "done"
        assert task["finishedAt"]
        assert task["events"][-1]["type"] == "task.status"
        assert task["events"][-1]["actorUserId"] == ALICE
        repeated = client.patch(url, json={"status": "done"}).json()
        assert repeated["events"] == task["events"]
        assert client.get(url).json()["finishedAt"] == task["finishedAt"]


@pytest.mark.parametrize("terminal", ["undelivered", "run.completed", "run.failed", "run.cancelled", "late_start"])
def test_manual_completion_settles_only_undelivered_work_before_daemon_exit(setup, terminal):
    app, client, node, agent, project = setup
    task = client.post("/api/v1/tasks", json={
        "title": "Stop working", "projectId": project["id"], "assignedAgentId": agent["id"],
    }).json()
    url = f"/api/v1/tasks/{task['id']}"
    started = client.post(f"{url}/runs", json={}).json()
    assert started["dispatch"]["state"] == "started"
    registry = app.state.registry
    token = f"token_{node['id']}"
    sid = started["session"]["id"]
    if terminal != "undelivered":
        [command] = registry.take_commands(node["id"], token)
        event = {key: command[key] for key in ("runId", "sessionId", "agent", "leaseId")}
        event["commandId"] = command["id"]
        if terminal != "late_start":
            registry.handle_event(node["id"], {**event, "type": "run.executing"}, token)
    response = client.patch(url, json={"status": "done"})
    assert response.status_code == 200, response.text
    done = response.json()
    assert done["status"] == "done"
    active = registry.daemon_store.active_run_request_for_task(task["id"])
    commands = registry.take_commands(node["id"], token)
    if terminal == "undelivered":
        assert active is None
        assert commands == []
    else:
        assert active["sessionId"] == sid
        assert [cmd["type"] for cmd in commands] == ["run.cancel"]
        assert commands[0]["commandId"] == command["id"]
        assert app.state.session_store.get_session_header(sid)["status"] == "running"
        if terminal == "late_start":
            registry.handle_event(node["id"], {**event, "type": "run.executing"}, token)
            terminal = "run.completed"
        registry.handle_event(node["id"], {
            **event, "type": terminal, "exitCode": 0 if terminal == "run.completed" else 1,
            "roundResult": {"status": "blocked", "question": "Continue?"},
        }, token)
        assert registry.daemon_store.active_run_request_for_task(task["id"]) is None
        assert app.state.session_store.get_session_header(sid)["status"] == "cancelled"
    assert app.state.task_store.get_task(task["id"])["events"] == done["events"]
    assert not any(event["type"] == "session.execution_reconciled"
                   for event in app.state.session_store.get_session(sid)["events"])


def test_completion_between_dispatch_claim_and_admission_supersedes_start(setup, monkeypatch):
    app, client, _, agent, project = setup
    task = client.post("/api/v1/tasks", json={
        "title": "Dispatch races completion", "projectId": project["id"], "assignedAgentId": agent["id"],
    }).json()
    url = f"/api/v1/tasks/{task['id']}"
    original = app.state.backend.run

    async def complete_then_admit(*args, **kwargs):
        assert app.state.task_store.get_task(task["id"]).get("dispatchClaim")
        result = await asyncio.to_thread(client.patch, url, json={"status": "done"})
        assert result.status_code == 200, result.text
        return await original(*args, **kwargs)

    monkeypatch.setattr(app.state.backend, "run", complete_then_admit)
    started = client.post(f"{url}/runs", json={})
    assert started.status_code == 202, started.text
    assert started.json()["dispatch"]["code"] == "dispatch_superseded"
    final = app.state.task_store.get_task(task["id"])
    assert final["status"] == "done"
    assert "dispatchClaim" not in final
    assert final["linkedSessionIds"] == task["linkedSessionIds"]
    assert app.state.registry.daemon_store.active_run_request_for_task(task["id"]) is None


@pytest.mark.parametrize("operation", ["pickup", "routing"])
def test_completion_supersedes_start_before_a_dispatch_is_claimed(setup, monkeypatch, operation):
    from relay.api.tasks import runs
    from relay.tasks.dispatch import TaskDispatcher

    app, client, node, agent, project = setup
    task = client.post("/api/v1/tasks", json={"title": "Close during routing", "projectId": project["id"]}).json()
    url = f"/api/v1/tasks/{task['id']}"
    if operation == "pickup":
        original = runs.logical_agent_for_assignment

        def complete_during_assignment(*args, **kwargs):
            assert client.patch(url, json={"status": "done"}).status_code == 200
            return original(*args, **kwargs)

        monkeypatch.setattr(runs, "logical_agent_for_assignment", complete_during_assignment)
        response = client.post(f"{url}/pickups", json={"agentId": agent["id"]})
        assert response.status_code == 409, response.text
    else:
        original_resolve = TaskDispatcher._resolve_project_assignments

        def complete_during_routing(dispatcher):
            assert client.patch(url, json={"status": "done"}).status_code == 200
            return original_resolve(dispatcher)

        monkeypatch.setattr(TaskDispatcher, "_resolve_project_assignments", complete_during_routing)
        response = client.post(f"{url}/runs", json={})
        assert response.json()["session"] is None, response.text
    assert app.state.task_store.get_task(task["id"])["status"] == "done"
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


def test_completion_and_daemon_failure_on_different_replicas(setup, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    app, client, node, agent, project = setup
    replica = create_app(str(tmp_path))
    registry = replica.state.registry
    response = client.post("/api/v1/tasks", json={
        "title": "Two writers", "projectId": project["id"], "assignedAgentId": agent["id"],
    })
    url = f"/api/v1/tasks/{response.json()['id']}"
    assert client.post(f"{url}/runs", json={}).json()["dispatch"]["state"] == "started"
    token = f"token_{node['id']}"
    [command] = registry.take_commands(node["id"], token)
    event = {key: command[key] for key in ("runId", "sessionId", "agent", "leaseId")}
    event["commandId"] = command["id"]
    registry.handle_event(node["id"], {**event, "type": "run.executing"}, token)
    ready = Barrier(2)

    def report_exit():
        ready.wait(timeout=10)
        registry.handle_event(node["id"], {**event, "type": "run.failed", "exitCode": 1, "error": "stopped"}, token)

    with ThreadPoolExecutor(max_workers=1) as pool:
        exit_result = pool.submit(report_exit)
        ready.wait(timeout=10)
        result = client.patch(url, json={"status": "done"})
        exit_result.result(timeout=15)
    assert result.status_code == 200, result.text
    assert client.get(url).json()["status"] == "done"
    assert app.state.registry.daemon_store.active_run_request_for_task(response.json()["id"]) is None
