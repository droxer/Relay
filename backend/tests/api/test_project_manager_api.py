"""Relay's manager reads live project records and stages owner-applied changes."""
from fastapi.testclient import TestClient
import test_project_setup_api as setup_api
from test_project_setup_api import _take_command, _complete

setup_env = setup_api.setup_env


def _ready(app, node):
    app.state.registry.register({
        "sandboxId": node["id"], "userId": node["userId"],
        "token": f"token_{node['id']}", "protocolVersion": 1,
        "supportedAgents": ["codex", "claude"],
        "capabilities": ["thread-workspaces", "project-workspaces", "project-manager"],
        "status": "ready", "workspacePath": "/workspace/relay",
        "workspaceId": node["workspaceId"],
    })


def _start(env):
    app, client, node, project, *_ = env
    _ready(app, node)
    response = client.post(f"/api/v1/projects/{project['id']}/manager/messages", json={
        "text": "What should we do next?", "idempotencyKey": "manager-first",
    })
    assert response.status_code == 202, response.text
    return response.json(), _take_command(app, node)


def _tool(env, command, tool, arguments=None):
    app, _, node, *_ = env
    return TestClient(app).post(
        f"/api/v1/daemon-nodes/{node['id']}/project-manager/tools",
        headers={"Authorization": f"Bearer token_{node['id']}"},
        json={"commandId": command["id"], "leaseId": command["leaseId"],
              "tool": tool, "arguments": arguments or {}},
    )


def test_manager_read_selects_stable_default_without_a_run(setup_env):
    app, client, _, project, planner, _ = setup_env
    url = f"/api/v1/projects/{project['id']}/manager"
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()["manager"]["agentId"] == planner["id"]
    assert response.json()["manager"]["threadId"] is None
    assert not app.state.session_store.list_sessions()
    assert not client.get(url).json()["manager"]["toolsAvailable"]


def test_manager_round_is_single_agent_thread_scoped_and_reuses_thread(setup_env):
    app, client, node, project, planner, _ = setup_env
    result, command = _start(setup_env)
    assert command["state"]["project_manager"]["projectId"] == project["id"]
    assert command["logicalAgentId"] == planner["id"]
    assert not command.get("taskId")
    _complete(app, node, command, result["threadId"])
    transcript = client.get(f"/api/v1/threads/{result['threadId']}").json()
    assert any(event.get("text") == "What should we do next?" for event in transcript["events"])
    second = client.post(f"/api/v1/projects/{project['id']}/manager/messages", json={
        "text": "And now?", "idempotencyKey": "manager-second",
    })
    assert second.status_code == 202, second.text
    assert second.json()["threadId"] == result["threadId"]


def test_live_tools_proposals_apply_once_in_backlog(setup_env):
    app, client, node, project, _, builder = setup_env
    result, command = _start(setup_env)
    url = f"/api/v1/projects/{project['id']}/manager"
    task = client.post("/api/v1/tasks", json={"title": "Old title", "projectId": project["id"]}).json()
    read = _tool(setup_env, command, "tasks")
    assert read.status_code == 200, read.text
    assert read.json()["tasks"][0]["title"] == "Old title"
    staged = _tool(setup_env, command, "propose", {"operations": [
        {"kind": "update", "taskId": task["id"], "fields": {"title": "New title", "priority": "high"}},
        {"kind": "create", "key": "build", "fields": {"title": "Build", "assignedAgentId": builder["id"]}, "afterTaskIds": [task["id"]]},
    ]})
    assert staged.status_code == 200, staged.text
    proposal = staged.json()["proposal"]
    assert client.get(f"/api/v1/tasks/{task['id']}").json()["title"] == "Old title"
    _complete(app, node, command, result["threadId"])
    applied = client.post(f"{url}/proposals/{proposal['id']}/apply", json={"idempotencyKey": "apply-one"})
    assert applied.status_code == 200, applied.text
    created = applied.json()["tasks"][1]
    assert created["status"] == "backlog"
    assert created["prerequisiteTaskIds"] == [task["id"]]
    assert created["assignedAgentId"] == builder["id"]
    assert client.get(f"/api/v1/tasks/{task['id']}").json()["title"] == "New title"
    again = client.post(f"{url}/proposals/{proposal['id']}/apply", json={"idempotencyKey": "apply-one"})
    assert again.status_code == 200
    assert again.json() == applied.json()
    assert _tool(setup_env, command, "overview").status_code == 409


def test_stale_proposal_rolls_back_and_scope_cannot_be_forged(setup_env):
    app, client, _, project, *_ = setup_env
    _, command = _start(setup_env)
    task = client.post("/api/v1/tasks", json={"title": "One", "projectId": project["id"]}).json()
    staged = _tool(setup_env, command, "propose", {"operations": [
        {"kind": "create", "fields": {"title": "Must roll back"}},
        {"kind": "update", "taskId": task["id"], "fields": {"priority": "high"}},
    ]})
    assert staged.status_code == 200, staged.text
    client.patch(f"/api/v1/tasks/{task['id']}", json={"title": "Changed elsewhere"})
    response = client.post(f"/api/v1/projects/{project['id']}/manager/proposals/{staged.json()['proposal']['id']}/apply", json={"idempotencyKey": "stale"})
    assert response.status_code == 409
    assert all(t["title"] != "Must roll back" for t in client.get("/api/v1/tasks").json()["tasks"])
    assert _tool(setup_env, command, "task", {"taskId": "foreign"}).status_code == 404
    assert _tool(setup_env, command, "apply", {}).status_code == 400
    client.cookies.clear()
    assert client.get(f"/api/v1/projects/{project['id']}/manager").status_code == 401


def test_manager_configuration_is_stable_and_disabled_projects_are_read_only(setup_env):
    app, client, _, project, planner, builder = setup_env
    url = f"/api/v1/projects/{project['id']}/manager"
    initial = client.get(url).json()
    changed = client.put(url, json={"agentId": builder["id"], "expectedVersion": initial["project"]["version"]})
    assert changed.status_code == 200, changed.text
    assert changed.json()["manager"]["agentId"] == builder["id"]
    assert changed.json()["project"]["leadAgentId"] is None
    assert client.put(url, json={"agentId": planner["id"], "expectedVersion": initial["project"]["version"]}).status_code == 409
    current = changed.json()["project"]
    client.patch(f"/api/v1/projects/{project['id']}", json={"enabled": False, "expectedVersion": current["version"]})
    assert client.get(url).status_code == 200
    assert client.post(f"{url}/messages", json={"text":"Hello", "idempotencyKey":"disabled"}).status_code == 409
    assert not app.state.session_store.list_sessions()


def test_foreign_project_and_node_tokens_never_grant_owner_apply(setup_env):
    app, client, node, project, *_ = setup_env
    _, command = _start(setup_env)
    staged = _tool(setup_env, command, "propose", {"operations": [{"kind":"create", "fields":{"title":"Private"}}]}).json()["proposal"]
    isolated = TestClient(app)
    url = f"/api/v1/projects/{project['id']}/manager"
    assert isolated.post(f"{url}/proposals/{staged['id']}/apply", headers={"Authorization":f"Bearer token_{node['id']}"}, json={"idempotencyKey":"unauthorized"}).status_code == 401
    isolated.post("/api/v1/auth/login", json={"username":"admin","password":"kestrel-vault-7719"})
    assert isolated.get(url).status_code == 403
    assert _tool(setup_env, command, "overview", {"projectId":"other"}).status_code == 403
    invalid_lease = {**command, "leaseId":"wrong"}
    assert _tool(setup_env, invalid_lease, "overview").status_code == 409


def test_pagination_activity_and_unconfigured_state(setup_env):
    app, client, _, project, planner, builder = setup_env
    _, command = _start(setup_env)
    for i in range(4):
        client.post("/api/v1/tasks", json={"title":f"Todo {i}","projectId":project["id"]})
    first = _tool(setup_env, command, "tasks", {"limit":2}).json()
    second = _tool(setup_env, command, "tasks", {"limit":2,"cursor":first["nextCursor"]}).json()
    assert first["total"] == second["total"] == 4
    assert len({task["id"] for task in first["tasks"] + second["tasks"]}) == 4
    activity = _tool(setup_env, command, "activity").json()
    assert len([item for item in activity["events"] if item.get("taskId")]) == 4
    page = _tool(setup_env, command, "activity", {"limit":2,"cutoff":activity["cutoff"]}).json()
    assert len(page["events"]) == page["nextCursor"] == 2
    assert _tool(setup_env, command, "tasks", {"limit":True}).status_code == 400
    assert _tool(setup_env, command, "task", {"taskId":{}}).status_code == 400
    for agent in [planner,builder]:
        app.state.agent_store.update_agent(agent["id"], {"enabled":False})
    data = client.get(f"/api/v1/projects/{project['id']}/manager").json()
    assert data["manager"]["agentId"] == planner["id"]
    assert data["manager"]["reason"] == "manager_agent_unavailable"


def test_selected_plan_missing_prerequisite_and_invalid_assignment_roll_back(setup_env):
    _, client, _, project, *_ = setup_env
    _, command = _start(setup_env)
    staged = _tool(setup_env, command, "propose", {"operations":[
        {"kind":"create","key":"first","fields":{"title":"First"}},
        {"kind":"create","key":"second","fields":{"title":"Second"},"after":["first"]},
    ]}).json()["proposal"]
    url = f"/api/v1/projects/{project['id']}/manager/proposals/{staged['id']}/apply"
    assert client.post(url, json={"idempotencyKey":"partial", "operationIds":["1"]}).status_code == 400
    assert client.get("/api/v1/tasks").json()["tasks"] == []
    result = client.post(url, json={"idempotencyKey":"first-only", "operationIds":["0"],"fields":{"0":{"title":"Edited first"}}})
    assert result.status_code == 200, result.text
    assert result.json()["tasks"][0]["title"] == "Edited first"
    assert client.post(url, json={"idempotencyKey":"first-only", "operationIds":["1"]}).status_code == 409


def test_existing_foreign_task_and_thread_are_inaccessible(setup_env):
    _, client, node, project, *_ = setup_env
    started, command = _start(setup_env)
    other = client.post('/api/v1/projects', json={'name':'Other', 'daemonNodeId':node['id'], 'members':[]}).json()['project']
    private = client.post('/api/v1/tasks', json={'title':'Other private task','projectId':other['id']}).json()
    assert _tool(setup_env, command, 'task', {'taskId':private['id']}).status_code == 404
    assert _tool(setup_env, command, 'propose', {'operations':[{'kind':'update','taskId':private['id'],'fields':{'title':'Stolen'}}]}).status_code == 404
    overview = _tool(setup_env, command, 'overview').json()
    assert overview['total'] == 0
    assert _tool(setup_env, command, 'thread', {'threadId':'missing'}).status_code == 404
    thread = _tool(setup_env, command, 'thread', {'threadId':started['threadId']})
    assert thread.status_code == 200
    assert any(message.get('text') == 'What should we do next?' for message in thread.json()['messages'])
    assert _tool(setup_env, command, 'threads').status_code == 200
    busy = client.post(f"/api/v1/projects/{project['id']}/manager/messages",json={'text':'Another turn','idempotencyKey':'busy'})
    assert busy.status_code == 409


def test_cycle_apply_rolls_back_metadata_and_rejects_dismissed_proposal(setup_env):
    _, client, _, project, *_ = setup_env
    _, command = _start(setup_env)
    first = client.post('/api/v1/tasks',json={'title':'First','projectId':project['id']}).json()
    second = client.post('/api/v1/tasks',json={'title':'Second','projectId':project['id']}).json()
    client.put(f"/api/v1/tasks/{second['id']}/prerequisites",json={'prerequisiteTaskIds':[first['id']]})
    staged = _tool(setup_env,command,'propose',{'operations':[
        {'kind':'update','taskId':first['id'],'fields':{'title':'Must roll back'}},
        {'kind':'prerequisites','taskId':first['id'],'afterTaskIds':[second['id']]},
    ]}).json()['proposal']
    url=f"/api/v1/projects/{project['id']}/manager/proposals/{staged['id']}"
    applied=client.post(f'{url}/apply',json={'idempotencyKey':'cycle'})
    assert applied.status_code == 409, applied.text
    assert client.get(f"/api/v1/tasks/{first['id']}").json()['title'] == 'First'
    assert client.post(f'{url}/dismiss').status_code == 200
    assert client.post(f'{url}/apply',json={'idempotencyKey':'dismissed'}).status_code == 409


def test_canonical_thread_creation_and_application_are_serialized(setup_env):
    from concurrent.futures import ThreadPoolExecutor
    from relay.projects.manager import ensure_manager_thread
    app, client, _, project, *_ = setup_env
    project = client.get(f"/api/v1/projects/{project['id']}/manager").json()['project']
    with ThreadPoolExecutor(max_workers=4) as pool:
        threads = list(pool.map(lambda _: ensure_manager_thread(app.state.context, project)[1], range(4)))
    assert len(set(threads)) == 1
    assert len(app.state.session_store.list_sessions()) == 1
    _, command = _start(setup_env)
    staged = _tool(setup_env,command,'propose',{'operations':[{'kind':'create','fields':{'title':'Exactly once'}}]}).json()['proposal']
    url=f"/api/v1/projects/{project['id']}/manager/proposals/{staged['id']}/apply"
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(url,json={'idempotencyKey':'concurrent'}),range(2)))
    assert [r.status_code for r in responses] == [200,200]
    assert responses[0].json() == responses[1].json()
    assert len(client.get('/api/v1/tasks').json()['tasks']) == 1


def test_archived_history_remains_readable_and_new_work_is_refused(setup_env):
    app, client, node, project, *_ = setup_env
    started, command = _start(setup_env)
    _complete(app,node,command,started['threadId'])
    current=client.get(f"/api/v1/projects/{project['id']}").json()['project']
    archived=client.post(f"/api/v1/projects/{project['id']}/archive?expectedVersion={current['version']}")
    assert archived.status_code == 200
    url=f"/api/v1/projects/{project['id']}/manager"
    assert client.get(url).status_code == 200
    assert client.get(f'{url}/overview').status_code == 200
    assert client.post(f'{url}/messages',json={'text':'More work','idempotencyKey':'archived'}).status_code == 409


def test_legacy_backfill_is_idempotent_and_never_creates_threads(setup_env):
    from relay.migrations_runtime.project_managers import initialize_project_managers
    app, _, _, project, planner, *_ = setup_env
    legacy=app.state.project_store.create_project(project['ownerUserId'],{
        'name':'Legacy project', 'computerId':project['computerId'], 'members':[], 'leadAgentId':None,
    })
    initialize_project_managers(app.state.context)
    first=app.state.project_store.get_project(legacy['id'])
    assert first['managerAgentId'] == planner['id']
    initialize_project_managers(app.state.context)
    assert app.state.project_store.get_project(legacy['id'])['version'] == first['version']
    assert not app.state.session_store.list_sessions()


def test_crewed_project_manager_does_not_dispatch_the_roster(setup_env):
    from test_project_plan_api import _crewed
    app,client,node,project,planner,builder=setup_env
    _crewed(client,project,planner,builder)
    view=client.get(f"/api/v1/projects/{project['id']}/manager").json()
    response=client.put(f"/api/v1/projects/{project['id']}/manager",json={'agentId':builder['id'],'expectedVersion':view['project']['version']})
    assert response.status_code == 200
    assert response.json()['project']['leadAgentId'] == planner['id']
    _,command=_start(setup_env)
    assert command['logicalAgentId'] == builder['id']
    assert command['state']['project_manager']['agentId'] == builder['id']
    assert len(app.state.session_store.list_sessions()) == 1


def test_project_creation_accepts_manager_choice_without_executing(setup_env):
    app,client,node,_,_,builder=setup_env
    result=client.post('/api/v1/projects',json={'name':'Explicit manager','daemonNodeId':node['id'],'members':[],'managerAgentId':builder['id']})
    assert result.status_code == 201, result.text
    assert result.json()['project']['managerAgentId'] == builder['id']
    invalid=client.post('/api/v1/projects',json={'name':'Invalid manager','daemonNodeId':node['id'],'members':[],'managerAgentId':'missing'})
    assert invalid.status_code == 400
    assert not app.state.session_store.list_sessions()


def test_project_updates_include_agent_reports_from_project_conversations(setup_env):
    app,client,node,project,*_=setup_env
    started,first=_start(setup_env)
    _complete(app,node,first,started['threadId'])
    response=client.post(f"/api/v1/projects/{project['id']}/manager/messages",json={'text':'What changed?','idempotencyKey':'updates-after-report'})
    assert response.status_code == 202,response.text
    command=_take_command(app,node)
    activity=_tool(setup_env,command,'activity').json()
    assert any(item['event'].get('type') == 'agent.completed' and 'Drafted the setup.' in item['event'].get('agentLog','') for item in activity['events'])


def test_project_manager_is_a_project_roster_role_not_a_global_agent_role(setup_env):
    app,client,node,project,planner,builder=setup_env
    current=client.get(f"/api/v1/projects/{project['id']}").json()['project']
    response=client.patch(f"/api/v1/projects/{project['id']}",json={
        'expectedVersion':current['version'],'leadAgentId':builder['id'],
        'members':[
            {'agentId':planner['id'],'role':'project_manager','responsibilities':'Manage this project','enabled':True},
            {'agentId':builder['id'],'role':'implementer','responsibilities':'Build','enabled':True},
        ],
    })
    assert response.status_code == 200,response.text
    saved=response.json()['project']
    assert saved['managerAgentId'] == planner['id']
    assert saved['leadAgentId'] == builder['id']
    assert app.state.agent_store.get_agent(planner['id'])['defaultRole'] == 'implementer'
    duplicate=client.patch(f"/api/v1/projects/{project['id']}",json={
        'expectedVersion':saved['version'],'leadAgentId':builder['id'],
        'members':[{**m,'role':'project_manager'} for m in saved['members']],
    })
    assert duplicate.status_code == 400


def test_open_manager_uses_a_normal_agent_thread_without_dispatch(setup_env):
    app,client,node,project,planner,_=setup_env
    response=client.post(f"/api/v1/projects/{project['id']}/manager/conversation")
    assert response.status_code == 200,response.text
    thread_id=response.json()['threadId']
    session=client.get(f'/api/v1/threads/{thread_id}').json()
    assert session['ownerAgentId'] == planner['id']
    assert session['participantAgentIds'] == [planner['id']]
    assert not session['agentRuns']
    assert client.post(f"/api/v1/projects/{project['id']}/manager/conversation").json()['threadId'] == thread_id
    _ready(app,node)
    message=client.post(f'/api/v1/threads/{thread_id}/messages',json={
        'text':'What changed in the project?','intent':'accomplish','idempotencyKey':'normal-manager-message',
    })
    assert message.status_code == 202,message.text
    command=_take_command(app,node)
    assert command['logicalAgentId'] == planner['id']
    assert command['state']['project_manager']['projectId'] == project['id']
