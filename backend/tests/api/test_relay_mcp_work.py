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


def call(client, token, tool_name, **arguments):
    response = _rpc(client, token, "tools/call", {"name": tool_name, "arguments": arguments})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert not result.get("isError"), result
    return result["structuredContent"]


def test_current_lead_can_start_a_project_task_with_its_saved_assignment(managed_env):
    app, owner, node, project, former, worker = managed_env
    _join(managed_env, worker)
    _ready(app, node, max_runs=3)
    discussion, lead_command = _start(managed_env)
    lead_token = credential(app, node, lead_command)
    task = owner.post("/api/v1/tasks", json={
        "title": "Implement approved plan", "projectId": project["id"], "assignedAgentId": worker["id"],
    }).json()
    with TestClient(app) as client:
        names = {tool["name"] for tool in _rpc(client, lead_token, "tools/list").json()["result"]["tools"]}
        assert "relay_start_task" in names
        started = call(client, lead_token, "relay_start_task", taskId=task["id"])
        assert started["dispatch"]["state"] == "started", started["dispatch"]
        assert started["task"]["assignedAgentId"] == worker["id"]
        command = _take_command(app, node)
        assert command["sessionId"] == started["threadId"] != discussion["threadId"]
        assert command["logicalAgentId"] == worker["id"]
        replay = call(client, lead_token, "relay_start_task", taskId=task["id"])
        assert replay["dispatch"]["code"] == "task_execution_active"
        assert len(app.state.task_store.get_task(task["id"])["linkedSessionIds"]) == 1
        worker_token = credential(app, node, command)
        names = {tool["name"] for tool in _rpc(client, worker_token, "tools/list").json()["result"]["tools"]}
        assert "relay_start_task" not in names
        retry_task = owner.post("/api/v1/tasks", json={
            "title": "Follow-up", "projectId": project["id"], "assignedAgentId": former["id"],
        }).json()
        args = {"taskId": retry_task["id"]}
        assert _rpc(client, worker_token, "tools/call", {
            "name": "relay_start_task", "arguments": args,
        }).json()["result"]["isError"]
        manager_api._assign(owner, project, worker)
        stale = _rpc(client, lead_token, "tools/call", {"name": "relay_start_task", "arguments": args}).json()["result"]
        assert stale["isError"]
        assert stale["content"][0]["text"] == "project_manager_required"
        _complete(app, node, lead_command, discussion["threadId"])
        _complete(app, node, command, command["sessionId"])
        _, next_lead = _start(managed_env, key="new-lead")
        next_token = credential(app, node, next_lead)
        assert call(client, next_token, "relay_start_task", **args)["dispatch"]["state"] == "started"
        assert _take_command(app, node)["logicalAgentId"] == former["id"]


def test_lead_task_start_applies_prerequisites_and_project_scope(managed_env):
    app, owner, node, project, *_ = managed_env
    _, command = _start(managed_env)
    lead_token = credential(app, node, command)
    outside = owner.post("/api/v1/tasks", json={"title": "Outside the project"}).json()
    blocker = owner.post("/api/v1/tasks", json={"title": "First", "projectId": project["id"]}).json()
    task = owner.post("/api/v1/tasks", json={"title": "Second", "projectId": project["id"]}).json()
    app.state.task_store.set_task_prerequisites(task["id"], [blocker["id"]], actor_user_id=node["userId"])
    with TestClient(app) as client:
        for token, task_id, expected in (
            (lead_token, outside["id"], "Project scope mismatch."),
            (lead_token, task["id"], "task_prerequisites_open"),
            (credential(app, node), task["id"], "project_manager_required"),
        ):
            result = _rpc(client, token, "tools/call", {
                "name": "relay_start_task", "arguments": {"taskId": task_id},
            }).json()["result"]
            assert result["isError"]
            assert result["content"][0]["text"] == expected
        assert not app.state.task_store.get_task(task["id"])["linkedSessionIds"]


def test_lead_can_plan_delegate_and_stop_project_work(managed_env):
    app, owner, node, project, _, worker = managed_env
    _join(managed_env, worker)
    _ready(app, node, max_runs=3)
    _, lead_command = _start(managed_env)
    token = credential(app, node, lead_command)
    with TestClient(app) as client:
        task = call(client, token, "relay_create_task", fields={"title": "Prepare release"})["task"]
        task_id = task["id"]
        planned = call(client, token, "relay_update_task", taskId=task_id, fields={
            "priority": "high", "assignedAgentId": worker["id"],
        })["task"]
        assert planned["priority"] == "high"
        assert planned["assignedAgentId"] == worker["id"]
        started = call(client, token, "relay_start_task", taskId=task_id)
        assert started["dispatch"]["state"] == "started", started["dispatch"]
        worker_run = _take_command(app, node)
        worker_token = credential(app, node, worker_run)
        assert worker_run["logicalAgentId"] == worker["id"]
        denied = _rpc(client, worker_token, "tools/call", {
            "name": "relay_stop_task", "arguments": {"taskId": task_id},
        }).json()["result"]
        assert denied["isError"]
        assert denied["content"][0]["text"] == "project_manager_required"
        stopped = call(client, token, "relay_stop_task", taskId=task_id, reason="Revisit release scope")
        assert stopped["threadId"] == worker_run["sessionId"]
        assert stopped["outcome"] == "stop_requested"
        assert call(client, token, "relay_stop_task", taskId=task_id)["outcome"] == "stop_requested"
        stop = _take_command(app, node)
        assert stop["type"] == "run.cancel"
        assert stop["commandId"] == worker_run["id"]
        assert stop["reason"] == "Revisit release scope"
        current = owner.get(f"/api/v1/tasks/{task_id}").json()
        assert current["assignedAgentId"] == worker["id"]
        assert app.state.daemon_store.active_run_request_for_task(task_id)


def test_lead_can_assign_and_start_a_workflow_task_without_skipping_approval(managed_env):
    app, owner, node, project, _, worker = managed_env
    _join(managed_env, worker)
    _ready(app, node, max_runs=3)
    _, lead_command = _start(managed_env)
    token = credential(app, node, lead_command)
    with TestClient(app) as client:
        workflow = call(client, token, "relay_create_workflow", projectId=project["id"], name="Release review", workflowSteps=[{
            "id": "release", "name": "Release", "agentId": worker["id"], "instructions": "Prepare the release.",
            "acceptanceCriteria": ["Release notes recorded"], "requiresApproval": True,
        }])["workflow"]
        task = call(client, token, "relay_create_task", fields={
            "title": "Release", "assignedWorkflowId": workflow["id"],
        })["task"]
        assert task["assignedWorkflowId"] == workflow["id"]
        refused = _rpc(client, token, "tools/call", {"name": "relay_update_task", "arguments": {
            "taskId": task["id"], "fields": {"assignedWorkflowId": None},
        }}).json()["result"]
        assert refused["isError"]
        assert "task_assignment_approval_required" in refused["content"][0]["text"]
        started = call(client, token, "relay_start_task", taskId=task["id"])
        assert started["dispatch"]["state"] == "started", started["dispatch"]
        thread = owner.get(f"/api/v1/threads/{started['threadId']}").json()
        assert thread["execution"]["blockingReason"] == "workflow_waiting_for_human"
        assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


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
        default = _rpc(client, token, "tools/call", {"name": "relay_create_task", "arguments": {"fields": {"title": "Project default"}}}).json()["result"]
        if lead:
            assert default["structuredContent"]["task"]["projectId"] == project["id"]
        else:
            assert default["isError"]
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
        owner.post("/api/v1/tasks", json={"title": f"Straße {index}", "computerId": project["computerId"]})
    owner.post("/api/v1/tasks", json={"title": "Straße in Project", "projectId": project["id"]})
    app.state.task_store.create_task({"title": "Straße foreign", "ownerUserId": user_id("bob")})
    owner.post("/api/v1/tasks", json={"title": "Straße automation", "computerId": project["computerId"], **paused_routine()})

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
        assert _rpc(client, token, "tools/call", {"name": "relay_create_task", "arguments": {"fields": {"title": "No scope escape"}}}).json()["result"]["isError"]


@pytest.mark.parametrize("automation", [False, True])
def test_computer_runtime_cannot_access_work_on_another_computer(managed_env, automation):
    from relay.core.computer_identity import computer_id
    app, _, node, _, *_ = managed_env
    token = credential(app, node)
    kind = "automation" if automation else "task"
    own = app.state.task_store.create_task({"title": "Here", "ownerUserId": node["userId"], "computerId": computer_id(node), "isRoutine": automation})
    other = app.state.task_store.create_task({"title": "Elsewhere", "ownerUserId": node["userId"], "computerId": "device:other:host", "isRoutine": automation})
    with TestClient(app) as client:
        page = call(client, token, f"relay_list_{'automations' if automation else 'tasks'}")
        assert [task["id"] for task in page[f"{'automations' if automation else 'tasks'}"]] == [own["id"]]
        for name, args in [(f"relay_get_{kind}", {f"{kind}Id": other["id"]}), (f"relay_update_{kind}", {f"{kind}Id": other["id"], "fields": {"title": "No"}}), (f"relay_delete_{kind}", {f"{kind}Id": other["id"]})]:
            assert _rpc(client, token, "tools/call", {"name": name, "arguments": args}).json()["result"]["isError"]
        created = call(client, token, f"relay_create_{kind}", fields={"title": "Bound"})[kind]
        assert created["computerId"] == computer_id(node)


def test_project_runtime_defaults_to_its_project_and_refuses_standalone_work(managed_env):
    app, _, node, project, *_ = managed_env
    _, command = _start(managed_env)
    token = credential(app, node, command)
    with TestClient(app) as client:
        created = call(client, token, "relay_create_task", fields={"title": "Project default"})["task"]
        assert created["projectId"] == project["id"]
        standalone = app.state.task_store.create_task({"title": "Standalone", "ownerUserId": node["userId"], "computerId": command.get("workspaceScope", {}).get("computerId")})
        response = _rpc(client, token, "tools/call", {"name": "relay_get_task", "arguments": {"taskId": standalone["id"]}}).json()["result"]
        assert response["isError"]


@pytest.mark.parametrize("automation", [False, True])
@pytest.mark.parametrize("project_work", [False, True])
@pytest.mark.parametrize("change", ["replace", "clear", "team"])
def test_agents_cannot_change_a_named_assignment_without_owner_approval(
    managed_env, automation, project_work, change,
):
    app, owner, node, project, planner, builder = managed_env
    _join(managed_env, builder)
    if project_work:
        _, command = _start(managed_env)
        token = credential(app, node, command)
    else:
        token = credential(app, node)
    kind = "automation" if automation else "task"
    created = owner.post("/api/v1/tasks", json={
        "title": "Keep my Agent", "assignedAgentId": builder["id"],
        **({"projectId": project["id"]} if project_work else {"computerId": project["computerId"]}),
        **(paused_routine() if automation else {}),
    })
    assert created.status_code == 201, created.text
    task = created.json()
    fields = {
        "replace": {"assignedAgentId": planner["id"]},
        "clear": {"assignedAgentId": None},
        "team": {"assignedTeamId": "replacement-team"},
    }[change]
    with TestClient(app) as client:
        result = _rpc(client, token, "tools/call", {"name": f"relay_update_{kind}", "arguments": {
            f"{kind}Id": task["id"], "fields": {"title": "Must not be applied", **fields},
        }}).json()["result"]
        assert result.get("isError"), result
        assert "task_assignment_approval_required" in str(result)
        unchanged = app.state.task_store.get_task(task["id"])
        assert unchanged["assignedAgentId"] == builder["id"]
        assert unchanged["title"] == "Keep my Agent"
        kept = call(client, token, f"relay_update_{kind}", **{f"{kind}Id": task["id"]},
                    fields={"title": "Same Agent", "assignedAgentId": builder["id"]})[kind]
        assert kept["assignedAgentId"] == builder["id"]
    # An explicit owner action is the approval; MCP cannot claim it on their behalf.
    approved = owner.patch(f"/api/v1/tasks/{task['id']}", json={"assignedAgentId": planner["id"]})
    assert approved.status_code == 200, approved.text
    assert approved.json()["assignedAgentId"] == planner["id"]


def test_project_assignment_proposal_waits_for_owner_apply(managed_env):
    app, owner, node, project, planner, builder = managed_env
    _join(managed_env, builder)
    _, command = _start(managed_env)
    token = credential(app, node, command)
    created = owner.post("/api/v1/tasks", json={
        "title": "Approval needed", "projectId": project["id"], "assignedAgentId": builder["id"],
    })
    assert created.status_code == 201, created.text
    task = created.json()
    with TestClient(app) as client:
        proposal = call(client, token, "relay_propose_task_changes", projectId=project["id"], operations=[{
            "kind": "update", "taskId": task["id"], "fields": {"assignedAgentId": planner["id"]},
        }])["proposal"]
        assert app.state.task_store.get_task(task["id"])["assignedAgentId"] == builder["id"]
        url = f"/api/v1/projects/{project['id']}/manager/proposals/{proposal['id']}/apply"
        assert client.post(url, headers={"Authorization": f"Bearer {token}"},
                           json={"idempotencyKey": "agent-cannot-approve"}).status_code == 401
    approved = owner.post(url, json={"idempotencyKey": "owner-approved-switch"})
    assert approved.status_code == 200, approved.text
    assert app.state.task_store.get_task(task["id"])["assignedAgentId"] == planner["id"]
