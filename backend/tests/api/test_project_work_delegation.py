import asyncio
from datetime import datetime, timedelta, UTC

import pytest
from task_setup import mark_task_ready
from automation_helpers import WEEKLY_TRIGGERS

import test_project_execution_policy as project_api
from test_project_routes import _agent, _login_alice


@pytest.fixture
def project_context(monkeypatch, tmp_path):
    return project_api.project_context.__wrapped__(monkeypatch, tmp_path)


def start_work(env, entry):
    app, client, node, project, lead, worker = env
    app.state.registry.register({
        "sandboxId": node["id"], "userId": node["userId"], "token": f"token_{node['id']}",
        "protocolVersion": 1, "supportedAgents": ["codex", "claude"],
        "workspacePath": node["workspacePath"], "workspaceId": node["workspaceId"],
        "capabilities": [*node["capabilities"], "work-results", "round-result", "direct-delegation",
                         "relay-thread-records", "handoff-validation"],
    })
    created = client.post("/api/v1/tasks", json={
        "title": "Build", "projectId": project["id"], "assignedAgentId": lead["id"],
        **({"isRoutine": True, "routineState": "active", "routineTriggers": WEEKLY_TRIGGERS} if entry.startswith("automation") else {}),
    })
    assert created.status_code == 201, created.text
    task = created.json()
    mark_task_ready(client, task)
    if entry == "automation_scheduler":
        assert app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=8)) >= 1
    if entry in ("scheduler", "automation_scheduler"):
        assert asyncio.run(app.state.task_scheduler.tick()).dispatched == 1
    else:
        response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert response.status_code == 202, response.text
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    return task, command


def finish(app, node, command, work):
    event = {"type": "run.completed", "commandId": command["id"], "runId": command["runId"],
             "sessionId": command["sessionId"], "agent": command["agent"], "exitCode": 0,
             "roundResult": {"status": work["status"], "work": work}, "agentLog": "Returned work"}
    app.state.registry.handle_event(node["id"], event, f"token_{node['id']}")


def delegation(worker):
    return {"status": "continue", "delegation": {"agentId": worker["id"], "objective": "Write tests",
        "acceptanceCriteria": ["Tests pass"], "expectedOutputs": ["tests"]}}


@pytest.mark.parametrize("entry", ["manual", "scheduler", "automation", "automation_scheduler"])
def test_project_work_delegates_and_returns_only_among_members(project_context, entry):
    app, client, node, project, lead, worker = project_context
    # Even another available Agent on this Computer cannot receive Project work.
    client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    outsider = _agent(client, app, node, "Outside", "codex")
    _login_alice(client)
    task, first = start_work(project_context, entry)
    ids = {item["agentId"] for item in first["state"].get("delegation_candidates", [])}
    assert ids == {worker["id"]}
    assert outsider["id"] not in ids
    finish(app, node, first, delegation(worker))
    [child] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert child["logicalAgentId"] == worker["id"]
    assert child["sessionId"] == first["sessionId"]
    finish(app, node, child, {"status": "done", "evidence": ["Tests pass"]})
    [resumed] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert resumed["logicalAgentId"] == lead["id"]
    request = app.state.registry.daemon_store.list_active_run_requests()[0]
    scope = request["state"]["_relay_collaboration_manifest"]["workScope"]
    assert scope["kind"] == "task"
    assert not app.state.task_store.get_task(scope["taskId"]).get("isRoutine")


@pytest.mark.parametrize("change", ["removed", "disabled"])
def test_member_changed_before_delegate_proposal_is_refused(project_context, change):
    app, client, node, project, lead, worker = project_context
    _, first = start_work(project_context, "manual")
    assert worker["id"] in {item["agentId"] for item in first["state"].get("delegation_candidates", [])}
    response = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": project["version"],
        "members": [
            {**member, "enabled": False} if member["agentId"] == worker["id"] else member
            for member in project["members"]
            if change != "removed" or member["agentId"] != worker["id"]
        ],
    })
    assert response.status_code == 200, response.text
    finish(app, node, first, delegation(worker))
    [resumed] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert resumed["logicalAgentId"] == lead["id"]
    assert "refused" in resumed["state"]["delegation_return"].lower()


def test_project_member_removed_between_delegate_admission_and_delivery(project_context):
    app, client, node, project, lead, worker = project_context
    _, first = start_work(project_context, "manual")
    original = app.state.registry.logical_assignment_validator
    removed = False

    def remove_after_admission(assignment):
        nonlocal removed
        original(assignment)
        if assignment.get("delegatedByAgentId") and not removed:
            removed = True
            app.state.project_store.update_project(project["id"], {
                "members": [member for member in project["members"] if member["agentId"] != worker["id"]],
            }, expected_version=project["version"])

    app.state.registry.logical_assignment_validator = remove_after_admission
    finish(app, node, first, delegation(worker))
    [resumed] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert resumed["logicalAgentId"] == lead["id"]
    assert "project_agent_not_member" in str(resumed["state"]["work_predecessor_results"])


@pytest.mark.parametrize("target", ["member", "member_pending", "outsider"])
@pytest.mark.parametrize("entry", ["manual", "automation"])
def test_project_task_handoff_keeps_task_scope_and_member_boundary(project_context, monkeypatch, target, entry):
    app, client, node, project, lead, worker = project_context
    client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"})
    outsider = _agent(client, app, node, "Outside", "codex")
    _login_alice(client)
    task, first = start_work(project_context, entry)
    finish(app, node, first, {"status": "blocked", "note": "Need help", "evidence": []})
    session_id = first["sessionId"]
    recovery_url = f"/api/v1/threads/{session_id}/recoveries"
    handoff = {"kind": "handoff", "targetAgentId": (outsider if target == "outsider" else worker)["id"],
               "idempotencyKey": "accept-handoff"}
    with monkeypatch.context() as patch:
        if target == "member_pending":
            patch.setattr(app.state.daemon_store, "publish_command", lambda *args, **kwargs: None)
        response = client.post(recovery_url, json=handoff)
    if target == "outsider":
        assert response.status_code == 400, response.text
        assert response.json()["detail"]["code"] == "project_agent_not_member"
    else:
        assert response.status_code == 202, response.text
        if target == "member_pending":
            assert response.json()["participantAgentIds"] == [lead["id"]]
            app.state.registry.reap_stale_runs(force=True)
        replay = client.post(recovery_url, json=handoff)
        assert replay.status_code == 202, replay.text
        assert replay.json()["participantAgentIds"] == [lead["id"], worker["id"]]
        [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
        assert command["logicalAgentId"] == worker["id"]
        assert command["sessionId"] == first["sessionId"]
        source, current = app.state.session_store.get_session(first["sessionId"])["collaborationRounds"][-2:]
        assert current["workScope"] == source["workScope"]


@pytest.mark.parametrize("entry", ["manual", "automation"])
@pytest.mark.parametrize("change", ["disabled", "removed"])
@pytest.mark.parametrize("publication", ["initial", "recover_unlinked", "recover_linked"])
def test_project_handoff_rechecks_membership_before_command_publication(
    project_context, monkeypatch, entry, change, publication,
):
    app, client, node, project, lead, worker = project_context
    _, first = start_work(project_context, entry)
    registry = app.state.registry
    store = registry.daemon_store
    token = f"token_{node['id']}"
    registry.handle_event(node["id"], {
        "type": "run.executing", "commandId": first["id"], "runId": first["runId"],
        "sessionId": first["sessionId"], "agent": first["agent"], "leaseId": first.get("leaseId"),
    }, token)
    finish(app, node, first, {"status": "blocked", "note": "Need help", "evidence": []})
    session_id = first["sessionId"]
    task_id = first["workspaceScope"]["taskId"]
    recovery_url = f"/api/v1/threads/{session_id}/recoveries"
    handoff = {"kind": "handoff", "targetAgentId": worker["id"], "idempotencyKey": "revoked-handoff"}
    link_command = store.update_run_request_if_claimed

    def revoke_membership():
        app.state.project_store.update_project(project["id"], {
            "members": [
                {**member, "enabled": False} if member["agentId"] == worker["id"] else member
                for member in project["members"]
                if change != "removed" or member["agentId"] != worker["id"]
            ],
        }, expected_version=project["version"])

    def link_before_membership_change(*args, **kwargs):
        linked = link_command(*args, **kwargs)
        if linked and (command_id := linked.get("currentCommandId")):
            assert store.get_command(command_id)["status"] == "pending"
            revoke_membership()
        return linked

    with monkeypatch.context() as patch:
        if publication == "recover_linked":
            patch.setattr(store, "publish_command", lambda *args, **kwargs: None)
        elif publication == "recover_unlinked":
            patch.setattr("relay.daemon_registry.config.DISPATCH_CLAIM_LEASE_SECONDS", 0)
            patch.setattr(store, "update_run_request_if_claimed", lambda *args, **kwargs: None)
        else:
            patch.setattr(store, "update_run_request_if_claimed", link_before_membership_change)
        response = client.post(recovery_url, json=handoff)
        assert response.status_code == 202, response.text
        assert response.json()["participantAgentIds"] == [lead["id"]]
        replay = client.post(recovery_url, json=handoff)
        assert replay.status_code == 202, replay.text
        assert replay.json()["participantAgentIds"] == [lead["id"]]
    if publication != "initial":
        request = store.active_run_request_for_session_any_node(session_id)
        assert bool(request.get("currentCommandId")) == (publication == "recover_linked")
        staged = store.pending_command_for_run_request(request["id"])
        assert staged["status"] == "pending"
        revoke_membership()
        with monkeypatch.context() as patch:
            if publication == "recover_linked":
                patch.setattr("relay.daemon_registry.config.DAEMON_RUN_TIMEOUT_MS", -1)
                patch.setattr(
                    registry, "cancel_active_run",
                    lambda *_: pytest.fail("The reaper tried to cancel the Thread after settling the rejected Handoff"),
                )
            registry.reap_stale_runs(force=True)

    assert not registry.take_commands(node["id"], token)
    assert store.active_run_request_for_session_any_node(session_id) is None
    task = app.state.task_store.get_task(task_id)
    assert task["status"] == "blocked"
    assert task["blockerReason"] == "project_agent_not_member"
    session = app.state.session_store.get_session(session_id)
    assert session["status"] == "failed"
    assert session["finalOutcome"] == "project_agent_not_member"
    assert [run["logicalAgentId"] for run in session["agentRuns"]] == [lead["id"]]
    replay = client.post(recovery_url, json=handoff)
    assert replay.status_code == 202, replay.text
    assert replay.json()["participantAgentIds"] == [lead["id"]]

    retry = client.post(recovery_url, json={"kind": "rerun", "targetAgentId": lead["id"]})
    assert retry.status_code == 202, retry.text
    [command] = registry.take_commands(node["id"], token)
    assert command["logicalAgentId"] == lead["id"]
    assert command["sessionId"] == session_id
    assert command["workspaceScope"] == first["workspaceScope"]
    owner = app.state.task_store.get_task(task_id)["executionOwner"]
    assert owner["revision"] == task["executionOwner"]["revision"] + 1
