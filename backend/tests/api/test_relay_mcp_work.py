"""Relay MCP authority follows the resource and the authenticated run identity."""

import pytest
from fastapi.testclient import TestClient
from automation_helpers import paused_routine
import test_project_manager_api as manager_api
import test_project_setup_api as setup_api
from test_project_manager_api import _start, _join, _run_task, _ready, _say
from test_project_setup_api import _take_command, _complete
from test_relay_mcp_protocol import _rpc

managed_env = manager_api.managed_env
setup_env = setup_api.setup_env


def credential(app, node, command=None):
    response = TestClient(app).post(
        f"/api/v1/daemon-nodes/{node['id']}/mcp-token",
        headers={"Authorization": f"Bearer token_{node['id']}"},
        json={"commandId": command["id"], "leaseId": command["leaseId"]} if command else {},
    )
    assert response.status_code == 201, response.text
    return response.json()["token"]


def call(client, token, name, **arguments):
    response = _rpc(client, token, "tools/call", {"name": name, "arguments": arguments})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert not result.get("isError"), result
    return result["structuredContent"]


@pytest.mark.parametrize("automation", [False, True])
def test_local_agents_manage_standalone_work_but_cannot_write_projects(managed_env, automation):
    app, owner, node, project, *_ = managed_env
    token = credential(app, node)
    kind = "automation" if automation else "task"
    fields = {"title": "Standalone", **(paused_routine() if automation else {})}
    fields.pop("isRoutine", None)
    with TestClient(app) as client:
        created = call(client, token, f"relay_create_{kind}", fields=fields)[kind]
        assert not created.get("projectId")
        key = f"{kind}Id"
        changed = call(client, token, f"relay_update_{kind}", **{key: created["id"]}, fields={"title": "Updated"})
        assert changed[kind]["title"] == "Updated"
        page = call(client, token, f"relay_list_{'automations' if automation else 'tasks'}")
        assert [row["id"] for row in page[f"{'automations' if automation else 'tasks'}"]] == [created["id"]]
        forbidden = _rpc(client, token, "tools/call", {"name": f"relay_create_{kind}", "arguments": {
            "projectId": project["id"], "fields": fields,
        }}).json()["result"]
        assert forbidden["isError"]
        deleted = call(client, token, f"relay_delete_{kind}", **{key: created["id"]})
        assert deleted["outcome"] == "deleted"


@pytest.mark.parametrize("lead", [False, True])
@pytest.mark.parametrize("automation", [False, True])
def test_project_roster_reads_and_only_lead_manages_work(managed_env, lead, automation):
    app, owner, node, project, _, builder = managed_env
    _join(managed_env, builder)
    if lead:
        _, command = _start(managed_env)
    else:
        command = _run_task(managed_env, {"title": "Read records", "assignedAgentId": builder["id"]})
    token = credential(app, node, command)
    kind = "automation" if automation else "task"
    record = owner.post("/api/v1/tasks", json={
        "title": "Project work", "projectId": project["id"], **(paused_routine() if automation else {}),
    }).json()
    with TestClient(app) as client:
        read = call(client, token, f"relay_get_{kind}", **{f"{kind}Id": record["id"]})
        assert read[kind]["id"] == record["id"]
        # Omitting projectId must not bypass the record's Project permissions.
        result = _rpc(client, token, "tools/call", {"name": f"relay_update_{kind}", "arguments": {
            f"{kind}Id": record["id"], "fields": {"title": "Changed"},
        }}).json()["result"]
        assert bool(result.get("isError")) is not lead, result
        fields = {"title": "Created by agent", **(paused_routine() if automation else {})}
        fields.pop("isRoutine", None)
        for name, args in [
            (f"relay_create_{kind}", {"projectId": project["id"], "fields": fields}),
            (f"relay_delete_{kind}", {f"{kind}Id": record["id"]}),
        ]:
            mutation = _rpc(client, token, "tools/call", {"name": name, "arguments": args}).json()["result"]
            assert bool(mutation.get("isError")) is not lead, mutation
        standalone = call(client, token, "relay_create_task", fields={"title": "Own standalone work"})
        assert not standalone["task"].get("projectId")
        # A reader still discovers standalone mutation tools.
        names = {t["name"] for t in _rpc(client, token, "tools/list").json()["result"]["tools"]}
        assert {"relay_create_task", "relay_create_automation"} <= names


def test_standalone_run_receives_mcp_and_token_dies_with_run(managed_env):
    app, owner, node, _, agent, _ = managed_env
    _ready(app, node)
    response = owner.post("/api/v1/threads", json={
        "taskGoal": "Manage standalone work", "assignments": [{"agentId": agent["id"], "mode": "action"}],
    })
    assert response.status_code in (200, 201, 202), response.text
    started = _say(owner, response.json()["id"], "Manage my work", agent["id"], "standalone-mcp")
    assert started.status_code == 202, started.text
    command = _take_command(app, node)
    assert not command["state"].get("project_manager")
    token = credential(app, node, command)
    with TestClient(app) as client:
        call(client, token, "relay_create_task", fields={"title": "From standalone run"})
        _complete(app, node, command, command["sessionId"])
        assert _rpc(client, token, "tools/list").status_code == 401


def test_project_identity_cannot_be_forged_and_other_resources_are_hidden(managed_env):
    app, owner, node, project, _, builder = managed_env
    _join(managed_env, builder)
    command = _run_task(managed_env, {"title": "Reader", "assignedAgentId": builder["id"]})
    token = credential(app, node, command)
    other = owner.post("/api/v1/projects", json={"name": "Other", "daemonNodeId": node["id"], "members": []}).json()["project"]
    task = owner.post("/api/v1/tasks", json={"title": "Other work", "projectId": other["id"]}).json()
    with TestClient(app) as client:
        for name, args in [
            ("relay_get_task", {"taskId": task["id"]}),
            ("relay_update_task", {"taskId": task["id"], "fields": {"title": "No"}}),
            ("relay_create_task", {"fields": {"title": "No", "projectId": project["id"]}}),
            ("relay_create_automation", {"fields": {"title": "No", "ownerUserId": "someone"}}),
        ]:
            result = _rpc(client, token, "tools/call", {"name": name, "arguments": args}).json()["result"]
            assert result["isError"], result


def test_owner_grant_without_project_filter_supports_standalone_work(managed_env):
    app, owner, _, _, *_ = managed_env
    issued = owner.post("/api/v1/mcp/tokens", json={"name": "Standalone agent"})
    assert issued.status_code == 201, issued.text
    with TestClient(app) as client:
        task = call(client, issued.json()["token"], "relay_create_task", fields={"title": "Owner grant"})
        assert task["task"]["ownerUserId"] == issued.json()["ownerUserId"]


@pytest.mark.parametrize("automation", [False, True])
def test_automation_pause_resume_and_owner_only_fields_are_guarded(managed_env, automation):
    app, _, node, _, agent, _ = managed_env
    token = credential(app, node)
    kind = "automation" if automation else "task"
    fields = {"title": "Work", **(paused_routine() if automation else {})}
    fields.pop("isRoutine", None)
    with TestClient(app) as client:
        task = call(client, token, f"relay_create_{kind}", fields=fields)[kind]
        key = {f"{kind}Id": task["id"]}
        if automation:
            active = call(client, token, "relay_update_automation", **key,
                          fields={"routineState": "active", "assignedAgentId": agent["id"]})
            assert active[kind]["routineState"] == "active"
            paused = call(client, token, "relay_update_automation", **key, fields={"routineState": "paused"})
            assert paused[kind]["routineState"] == "paused"
        for forbidden in ({"status": "done"}, {"acceptancePolicy": "automatic"},
                          {"projectId": "other"}, {"ownerUserId": "other"},
                          {"isRoutine": not automation}, {"createSession": True}):
            result = _rpc(client, token, "tools/call", {"name": f"relay_update_{kind}", "arguments": {
                **key, "fields": forbidden,
            }}).json()["result"]
            assert result["isError"], result


def test_work_lists_are_owner_scoped_paginated_and_do_not_load_histories(managed_env, monkeypatch):
    from user_ids import user_id
    app, owner, node, project, *_ = managed_env
    token = credential(app, node)
    for index in range(5):
        owner.post("/api/v1/tasks", json={"title": f"Straße {index}"})
    owner.post("/api/v1/tasks", json={"title": "Straße in Project", "projectId": project["id"]})
    app.state.task_store.create_task({"title": "Straße foreign", "ownerUserId": user_id("bob")})
    owner.post("/api/v1/tasks", json={"title": "Straße automation", **paused_routine()})

    def unbounded(*args, **kwargs):
        raise AssertionError("Work lists must query scoped snapshots without histories")

    monkeypatch.setattr(app.state.task_store, "get_task", unbounded)
    monkeypatch.setattr(app.state.task_store, "list_tasks", unbounded)
    with TestClient(app) as client:
        seen = set()
        cursor = ""
        while True:
            page = call(client, token, "relay_list_tasks", query="STRASSE", limit=2, cursor=cursor)
            assert page["total"] == 5
            ids = {row["id"] for row in page["tasks"]}
            assert ids.isdisjoint(seen)
            seen.update(ids)
            cursor = page["nextCursor"]
            if cursor is None:
                break
        assert len(seen) == 5


def test_lead_transfer_revokes_active_run_writes_and_disabled_members_lose_reads(managed_env):
    app, owner, node, project, former, successor = managed_env
    _join(managed_env, successor)
    _, command = _start(managed_env)
    token = credential(app, node, command)
    current = owner.get(f"/api/v1/projects/{project['id']}").json()["project"]
    changed = owner.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": current["version"], "leadAgentId": successor["id"],
    })
    assert changed.status_code == 200, changed.text
    with TestClient(app) as client:
        call(client, token, "relay_project_overview", projectId=project["id"])
        for name, args in [
            ("relay_create_task", {"projectId": project["id"], "fields": {"title": "Stale lead"}}),
            ("relay_propose_task_changes", {"projectId": project["id"], "operations": [{"kind": "create", "fields": {"title": "Stale lead"}}]}),
        ]:
            assert _rpc(client, token, "tools/call", {"name": name, "arguments": args}).json()["result"]["isError"]
        project = changed.json()["project"]
        disabled = owner.patch(f"/api/v1/projects/{project['id']}", json={
            "expectedVersion": project["version"], "members": [
                {**member, "enabled": member["agentId"] != former["id"]} for member in project["members"]
            ],
        })
        assert disabled.status_code == 200, disabled.text
        assert call(client, token, "relay_list_projects")["projects"] == []
        refused = _rpc(client, token, "tools/call", {"name": "relay_project_overview", "arguments": {"projectId": project["id"]}})
        assert refused.json()["result"]["isError"]
        call(client, token, "relay_create_task", fields={"title": "Still standalone"})
