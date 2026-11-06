"""Relay's manager is an ordinary Agent holding a Project role.

It reads live project records and stages owner-applied changes; the owner
talks to it through the ordinary Thread message route.
"""
from fastapi.testclient import TestClient
import pytest
import test_project_setup_api as setup_api
from test_project_setup_api import _take_command, _complete

setup_env = setup_api.setup_env


def _ready(app, node, *, tools=True, setup=False):
    app.state.registry.register({
        "sandboxId": node["id"], "userId": node["userId"],
        "token": f"token_{node['id']}", "protocolVersion": 1,
        "supportedAgents": ["codex", "claude"],
        "capabilities": ["thread-workspaces", "project-workspaces", "project-manager",
                         *(["project-manager-mcp"] if tools else []), *(["project-setup"] if setup else [])],
        "status": "ready", "workspacePath": "/workspace/relay",
        "workspaceId": node["workspaceId"],
    })


def _assign(client, project, agent):
    current = client.get(f"/api/v1/projects/{project['id']}").json()["project"]
    response = client.put(f"/api/v1/projects/{project['id']}/manager", json={
        "agentId": agent["id"], "expectedVersion": current["version"],
    })
    assert response.status_code == 200, response.text
    return response.json()["project"]


@pytest.fixture
def managed_env(setup_env):
    """The owner gave the planner the manager role; nothing picks one for them."""
    app, client, node, project, planner, builder = setup_env
    return app, client, node, _assign(client, project, planner), planner, builder


def _say(client, thread_id, text, agent_id, key):
    return client.post(f"/api/v1/threads/{thread_id}/messages", json={
        "text": text, "intent": "accomplish", "addressAgentIds": [agent_id], "idempotencyKey": key,
    })


def _start(env, text="What should we do next?", key="manager-first"):
    app, client, node, project, *_ = env
    _ready(app, node)
    thread_id = client.post(f"/api/v1/projects/{project['id']}/manager/conversation").json()["threadId"]
    holder = client.get(f"/api/v1/projects/{project['id']}").json()["project"]["managerAgentId"]
    response = _say(client, thread_id, text, holder, key)
    assert response.status_code == 202, response.text
    return {"threadId": thread_id}, _take_command(app, node)


def _tool(env, command, tool, arguments=None):
    app, _, node, *_ = env
    return TestClient(app).post(
        f"/api/v1/daemon-nodes/{node['id']}/project-manager/tools",
        headers={"Authorization": f"Bearer token_{node['id']}"},
        json={"commandId": command["id"], "leaseId": command["leaseId"],
              "tool": tool, "arguments": arguments or {}},
    )


def test_manager_read_never_assigns_the_role_or_writes(setup_env):
    app, client, _, project, *_ = setup_env
    url = f"/api/v1/projects/{project['id']}/manager"
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()["manager"]["agentId"] is None
    assert response.json()["manager"]["reason"] == "manager_unconfigured"
    assert response.json()["manager"]["threadId"] is None
    assert not client.get(url).json()["manager"]["toolsAvailable"]
    assert app.state.project_store.get_project(project["id"])["version"] == project["version"]
    assert not app.state.session_store.list_sessions()
    assert client.post(f"{url}/conversation").status_code == 409


def test_manager_conversation_is_an_ordinary_thread_and_is_reused(managed_env):
    app, client, node, project, planner, _ = managed_env
    result, command = _start(managed_env)
    assert command["state"]["project_manager"]["projectId"] == project["id"]
    assert command["logicalAgentId"] == planner["id"]
    assert not command.get("taskId")
    _complete(app, node, command, result["threadId"])
    transcript = client.get(f"/api/v1/threads/{result['threadId']}").json()
    assert any(event.get("text") == "What should we do next?" for event in transcript["events"])
    assert client.post(f"/api/v1/projects/{project['id']}/manager/conversation").json()["threadId"] == result["threadId"]
    second = _say(client, result["threadId"], "And now?", planner["id"], "manager-second")
    assert second.status_code == 202, second.text
    assert _take_command(app, node)["state"]["project_manager"]["agentId"] == planner["id"]


def test_live_tools_proposals_apply_once_in_backlog(managed_env):
    app, client, node, project, _, builder = managed_env
    result, command = _start(managed_env)
    url = f"/api/v1/projects/{project['id']}/manager"
    task = client.post("/api/v1/tasks", json={"title": "Old title", "projectId": project["id"]}).json()
    read = _tool(managed_env, command, "tasks")
    assert read.status_code == 200, read.text
    assert read.json()["tasks"][0]["title"] == "Old title"
    staged = _tool(managed_env, command, "propose", {"operations": [
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
    assert _tool(managed_env, command, "overview").status_code == 409


def test_stale_proposal_rolls_back_and_scope_cannot_be_forged(managed_env):
    app, client, _, project, *_ = managed_env
    _, command = _start(managed_env)
    task = client.post("/api/v1/tasks", json={"title": "One", "projectId": project["id"]}).json()
    staged = _tool(managed_env, command, "propose", {"operations": [
        {"kind": "create", "fields": {"title": "Must roll back"}},
        {"kind": "update", "taskId": task["id"], "fields": {"priority": "high"}},
    ]})
    assert staged.status_code == 200, staged.text
    client.patch(f"/api/v1/tasks/{task['id']}", json={"title": "Changed elsewhere"})
    response = client.post(f"/api/v1/projects/{project['id']}/manager/proposals/{staged.json()['proposal']['id']}/apply", json={"idempotencyKey": "stale"})
    assert response.status_code == 409
    assert all(t["title"] != "Must roll back" for t in client.get("/api/v1/tasks").json()["tasks"])
    assert _tool(managed_env, command, "task", {"taskId": "foreign"}).status_code == 404
    assert _tool(managed_env, command, "apply", {}).status_code == 400
    client.cookies.clear()
    assert client.get(f"/api/v1/projects/{project['id']}/manager").status_code == 401


def test_manager_configuration_is_stable_and_disabled_projects_are_read_only(managed_env):
    app, client, _, project, planner, builder = managed_env
    url = f"/api/v1/projects/{project['id']}/manager"
    initial = client.get(url).json()
    changed = client.put(url, json={"agentId": builder["id"], "expectedVersion": initial["project"]["version"]})
    assert changed.status_code == 200, changed.text
    assert changed.json()["manager"]["agentId"] == builder["id"]
    assert changed.json()["project"]["leadAgentId"] == initial["project"]["leadAgentId"]
    assert client.put(url, json={"agentId": planner["id"], "expectedVersion": initial["project"]["version"]}).status_code == 409
    current = changed.json()["project"]
    client.patch(f"/api/v1/projects/{project['id']}", json={"enabled": False, "expectedVersion": current["version"]})
    assert client.get(url).status_code == 200
    assert client.post(f"{url}/conversation").status_code == 409
    assert not app.state.session_store.list_sessions()


def test_foreign_project_and_node_tokens_never_grant_owner_apply(managed_env):
    app, client, node, project, *_ = managed_env
    _, command = _start(managed_env)
    staged = _tool(managed_env, command, "propose", {"operations": [{"kind":"create", "fields":{"title":"Private"}}]}).json()["proposal"]
    isolated = TestClient(app)
    url = f"/api/v1/projects/{project['id']}/manager"
    assert isolated.post(f"{url}/proposals/{staged['id']}/apply", headers={"Authorization":f"Bearer token_{node['id']}"}, json={"idempotencyKey":"unauthorized"}).status_code == 401
    isolated.post("/api/v1/auth/login", json={"username":"admin","password":"kestrel-vault-7719"})
    assert isolated.get(url).status_code == 403
    assert _tool(managed_env, command, "overview", {"projectId":"other"}).status_code == 403
    invalid_lease = {**command, "leaseId":"wrong"}
    assert _tool(managed_env, invalid_lease, "overview").status_code == 409


def test_pagination_activity_and_unconfigured_state(managed_env):
    app, client, _, project, planner, builder = managed_env
    _, command = _start(managed_env)
    for i in range(4):
        client.post("/api/v1/tasks", json={"title":f"Todo {i}","projectId":project["id"]})
    first = _tool(managed_env, command, "tasks", {"limit":2}).json()
    second = _tool(managed_env, command, "tasks", {"limit":2,"cursor":first["nextCursor"]}).json()
    assert first["total"] == second["total"] == 4
    assert len({task["id"] for task in first["tasks"] + second["tasks"]}) == 4
    activity = _tool(managed_env, command, "activity").json()
    assert len([item for item in activity["events"] if item.get("taskId")]) == 4
    page = _tool(managed_env, command, "activity", {"limit":2,"cutoff":activity["cutoff"]}).json()
    assert len(page["events"]) == page["nextCursor"] == 2
    assert _tool(managed_env, command, "tasks", {"limit":True}).status_code == 400
    assert _tool(managed_env, command, "task", {"taskId":{}}).status_code == 400
    for agent in [planner,builder]:
        app.state.agent_store.update_agent(agent["id"], {"enabled":False})
    data = client.get(f"/api/v1/projects/{project['id']}/manager").json()
    assert data["manager"]["agentId"] == planner["id"]
    assert data["manager"]["reason"] == "manager_agent_unavailable"


def test_selected_plan_missing_prerequisite_and_invalid_assignment_roll_back(managed_env):
    _, client, _, project, *_ = managed_env
    _, command = _start(managed_env)
    staged = _tool(managed_env, command, "propose", {"operations":[
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


def test_existing_foreign_task_and_thread_are_inaccessible(managed_env):
    _, client, node, project, *_ = managed_env
    started, command = _start(managed_env)
    other = client.post('/api/v1/projects', json={'name':'Other', 'daemonNodeId':node['id'], 'members':[]}).json()['project']
    private = client.post('/api/v1/tasks', json={'title':'Other private task','projectId':other['id']}).json()
    assert _tool(managed_env, command, 'task', {'taskId':private['id']}).status_code == 404
    assert _tool(managed_env, command, 'propose', {'operations':[{'kind':'update','taskId':private['id'],'fields':{'title':'Stolen'}}]}).status_code == 404
    overview = _tool(managed_env, command, 'overview').json()
    assert overview['total'] == 0
    assert _tool(managed_env, command, 'thread', {'threadId':'missing'}).status_code == 404
    thread = _tool(managed_env, command, 'thread', {'threadId':started['threadId']})
    assert thread.status_code == 200
    assert any(message.get('text') == 'What should we do next?' for message in thread.json()['messages'])
    assert _tool(managed_env, command, 'threads').status_code == 200


def test_cycle_apply_rolls_back_metadata_and_rejects_dismissed_proposal(managed_env):
    _, client, _, project, *_ = managed_env
    _, command = _start(managed_env)
    first = client.post('/api/v1/tasks',json={'title':'First','projectId':project['id']}).json()
    second = client.post('/api/v1/tasks',json={'title':'Second','projectId':project['id']}).json()
    client.put(f"/api/v1/tasks/{second['id']}/prerequisites",json={'prerequisiteTaskIds':[first['id']]})
    staged = _tool(managed_env,command,'propose',{'operations':[
        {'kind':'update','taskId':first['id'],'fields':{'title':'Must roll back'}},
        {'kind':'prerequisites','taskId':first['id'],'afterTaskIds':[second['id']]},
    ]}).json()['proposal']
    url=f"/api/v1/projects/{project['id']}/manager/proposals/{staged['id']}"
    applied=client.post(f'{url}/apply',json={'idempotencyKey':'cycle'})
    assert applied.status_code == 409, applied.text
    assert client.get(f"/api/v1/tasks/{first['id']}").json()['title'] == 'First'
    assert client.post(f'{url}/dismiss').status_code == 200
    assert client.post(f'{url}/apply',json={'idempotencyKey':'dismissed'}).status_code == 409


def test_canonical_thread_creation_and_application_are_serialized(managed_env):
    from concurrent.futures import ThreadPoolExecutor
    from relay.projects.manager import ensure_manager_thread
    app, client, _, project, *_ = managed_env
    project = client.get(f"/api/v1/projects/{project['id']}/manager").json()['project']
    with ThreadPoolExecutor(max_workers=4) as pool:
        threads = list(pool.map(lambda _: ensure_manager_thread(app.state.context, project)[1], range(4)))
    assert len(set(threads)) == 1
    assert len(app.state.session_store.list_sessions()) == 1
    _, command = _start(managed_env)
    staged = _tool(managed_env,command,'propose',{'operations':[{'kind':'create','fields':{'title':'Exactly once'}}]}).json()['proposal']
    url=f"/api/v1/projects/{project['id']}/manager/proposals/{staged['id']}/apply"
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(url,json={'idempotencyKey':'concurrent'}),range(2)))
    assert [r.status_code for r in responses] == [200,200]
    assert responses[0].json() == responses[1].json()
    assert len(client.get('/api/v1/tasks').json()['tasks']) == 1


def test_archived_history_remains_readable_and_new_work_is_refused(managed_env):
    app, client, node, project, *_ = managed_env
    started, command = _start(managed_env)
    _complete(app,node,command,started['threadId'])
    current=client.get(f"/api/v1/projects/{project['id']}").json()['project']
    archived=client.post(f"/api/v1/projects/{project['id']}/archive?expectedVersion={current['version']}")
    assert archived.status_code == 200
    url=f"/api/v1/projects/{project['id']}/manager"
    assert client.get(url).status_code == 200
    assert client.get(f'{url}/overview').status_code == 200
    assert client.post(f'{url}/conversation').json()['threadId'] == started['threadId']
    assert _say(client, started['threadId'], 'More work', project['managerAgentId'], 'archived').status_code in (404, 409)


def test_legacy_manager_role_reads_as_the_flag_and_nobody_is_picked(setup_env):
    app, client, _, project, planner, builder = setup_env
    legacy = app.state.project_store.create_project(project['ownerUserId'], {
        'name': 'Legacy project', 'computerId': project['computerId'], 'leadAgentId': builder['id'],
        'members': [
            {'agentId': planner['id'], 'role': 'project_manager', 'responsibilities': 'Coordinate', 'enabled': True},
            {'agentId': builder['id'], 'role': 'implementer', 'responsibilities': 'Build', 'enabled': True},
        ],
    })
    read = client.get(f"/api/v1/projects/{legacy['id']}").json()['project']
    assert read['managerAgentId'] == planner['id']
    assert read['members'][0]['role'] == 'planner'
    assert read['members'][0]['projectManager'] is True
    assert 'managerInitialized' not in read
    unassigned = app.state.project_store.create_project(project['ownerUserId'], {
        'name': 'Never assigned', 'computerId': project['computerId'], 'leadAgentId': None, 'members': [],
    })
    assert client.get(f"/api/v1/projects/{unassigned['id']}/manager").json()['manager']['agentId'] is None
    assert app.state.project_store.get_project(unassigned['id'])['version'] == unassigned['version']
    assert not app.state.session_store.list_sessions()


def test_crewed_project_manager_does_not_dispatch_the_roster(setup_env):
    from test_project_plan_api import _crewed
    app,client,node,project,planner,builder=setup_env
    crewed=_crewed(client,project,planner,builder)
    assert crewed['managerAgentId'] is None
    view=client.get(f"/api/v1/projects/{project['id']}/manager").json()
    response=client.put(f"/api/v1/projects/{project['id']}/manager",json={'agentId':builder['id'],'expectedVersion':view['project']['version']})
    assert response.status_code == 200
    assert response.json()['project']['leadAgentId'] == planner['id']
    assert [m['role'] for m in response.json()['project']['members']] == ['planner','implementer']
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
    empty=client.post('/api/v1/projects',json={'name':'No crew','daemonNodeId':node['id'],'members':[]})
    assert empty.json()['project']['managerAgentId'] is None
    crew=[{'agentId':builder['id'],'role':'reviewer','responsibilities':'Review','enabled':True}]
    led=client.post('/api/v1/projects',json={'name':'Led','daemonNodeId':node['id'],'members':crew,'leadAgentId':builder['id']}).json()['project']
    assert led['managerAgentId'] == builder['id']
    assert led['members'][0]['role'] == 'reviewer'
    open_role=client.post('/api/v1/projects',json={'name':'Open role','daemonNodeId':node['id'],'members':crew,'leadAgentId':builder['id'],'managerAgentId':None}).json()['project']
    assert open_role['managerAgentId'] is None
    assert not app.state.session_store.list_sessions()


def test_project_updates_include_agent_reports_from_project_conversations(managed_env):
    app,client,node,project,planner,*_=managed_env
    started,first=_start(managed_env)
    _complete(app,node,first,started['threadId'])
    response=_say(client,started['threadId'],'What changed?',planner['id'],'updates-after-report')
    assert response.status_code == 202,response.text
    command=_take_command(app,node)
    activity=_tool(managed_env,command,'activity').json()
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
    assert saved['members'][0] == {**saved['members'][0],'role':'planner','projectManager':True}
    assert saved['leadAgentId'] == builder['id']
    assert app.state.agent_store.get_agent(planner['id'])['defaultRole'] == 'implementer'
    reviewer=client.patch(f"/api/v1/projects/{project['id']}",json={
        'expectedVersion':saved['version'],'leadAgentId':builder['id'],'members':[
            {'agentId':planner['id'],'role':'reviewer','projectManager':True,'responsibilities':'Review and manage','enabled':True},
            {'agentId':builder['id'],'role':'implementer','responsibilities':'Build','enabled':True},
        ],
    })
    assert reviewer.status_code == 200,reviewer.text
    assert reviewer.json()['project']['members'][0]['role'] == 'reviewer'
    assert reviewer.json()['project']['managerAgentId'] == planner['id']
    duplicate=client.patch(f"/api/v1/projects/{project['id']}",json={
        'expectedVersion':reviewer.json()['project']['version'],'leadAgentId':builder['id'],
        'members':[{**m,'projectManager':True} for m in reviewer.json()['project']['members']],
    })
    assert duplicate.status_code == 400


def test_open_manager_uses_a_normal_agent_thread_without_dispatch(managed_env):
    app,client,node,project,planner,_=managed_env
    response=client.post(f"/api/v1/projects/{project['id']}/manager/conversation")
    assert response.status_code == 200,response.text
    thread_id=response.json()['threadId']
    session=client.get(f'/api/v1/threads/{thread_id}').json()
    assert session.get('ownerAgentId') is None
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


@pytest.mark.parametrize("via_roster", [False, True])
def test_handover_keeps_the_thread_and_roles_and_the_former_manager_stays_normal(managed_env, via_roster):
    app, client, node, project, first, second = managed_env
    thread_id = client.post(f"/api/v1/projects/{project['id']}/manager/conversation").json()['threadId']
    project = client.get(f"/api/v1/projects/{project['id']}").json()['project']
    first_role = next(m for m in project['members'] if m['agentId'] == first['id'])['role']
    changed = client.patch(f"/api/v1/projects/{project['id']}",json={
        'expectedVersion':project['version'],'members':[
            {k:v for k,v in m.items() if k != 'projectManager'} for m in project['members']
        ]+[{'agentId':second['id'],'role':'implementer','projectManager':True,'responsibilities':'Coordinate','enabled':True}],
    }) if via_roster else client.put(f"/api/v1/projects/{project['id']}/manager", json={
        'agentId':second['id'], 'expectedVersion':project['version'],
    })
    assert changed.status_code == 200, changed.text
    saved = changed.json()['project']
    assert saved['managerAgentId'] == second['id']
    assert next(m for m in saved['members'] if m['agentId'] == first['id'])['role'] == first_role
    thread = client.get(f'/api/v1/threads/{thread_id}').json()
    assert thread.get('ownerAgentId') is None
    assert thread['participantAgentIds'] == [first['id']]
    assert not any(e['type'] == 'thread.project_manager_assigned' for e in thread['events'])
    _ready(app,node)
    former = _say(client, thread_id, 'Update?', first['id'], 'former-manager')
    assert former.status_code == 202, former.text
    command = _take_command(app,node)
    assert command['logicalAgentId'] == first['id']
    assert 'project_manager' not in command['state']
    assert client.post(f"/api/v1/projects/{project['id']}/manager/conversation").json()['threadId'] == thread_id


def test_manager_role_grants_run_context_outside_canonical_thread(managed_env):
    app,client,node,project,manager,*_ = managed_env
    _ready(app,node)
    thread = app.state.session_store.create_session({
        'ownerUserId':project['ownerUserId'],'ownerAgentId':manager['id'],
        'projectId':project['id'],'computerId':project['computerId'],
        'workspaceLayout':'project','workspacePath':'','workspaceSubpath':project['workspaceSubpath'],
        'participants':['human'],'taskGoal':'Another project conversation',
    })
    response = client.post(f"/api/v1/threads/{thread['id']}/messages", json={
        'text':'Explain this project', 'addressAgentIds':[manager['id']], 'idempotencyKey':'role-scope',
    })
    assert response.status_code == 202,response.text
    command = _take_command(app,node)
    assert command['state']['project_manager']['agentId'] == manager['id']
    assert command['state']['project_manager']['projectId'] == project['id']
    read = _tool(managed_env,command,'overview')
    assert read.status_code == 200,read.text
    external = TestClient(app)
    grant = external.post(f"/api/v1/daemon-nodes/{node['id']}/mcp-token",headers={
        'Authorization':f"Bearer token_{node['id']}",
    },json={'commandId':command['id'],'leaseId':command['leaseId']})
    assert grant.status_code == 201,grant.text
    staged = external.post(f"/api/v1/mcp/projects/{project['id']}/tools",headers={
        'Authorization':f"Bearer {grant.json()['token']}",
    },json={'tool':'propose','arguments':{'operations':[{'kind':'create','fields':{'title':'Ordinary Thread proposal'}}]}})
    assert staged.status_code == 200,staged.text
    assert staged.json()['proposal']['threadId'] == thread['id']
    assert staged.json()['proposal']['runId'] == command['runId']
    assert app.state.project_store.get_project(project['id'])['managerThreadId'] is None


def test_an_older_computer_runs_the_manager_without_its_tools(managed_env):
    app, client, node, project, planner, _ = managed_env
    _ready(app, node, tools=False)
    thread_id = client.post(f"/api/v1/projects/{project['id']}/manager/conversation").json()['threadId']
    view = client.get(f"/api/v1/projects/{project['id']}/manager").json()
    assert view['manager']['reason'] == 'project_manager_update_required'
    assert _say(client, thread_id, 'Status?', planner['id'], 'old-computer').status_code == 202
    command = _take_command(app, node)
    assert command['logicalAgentId'] == planner['id']
    assert 'project_manager' not in command['state']


def test_manager_keeps_its_tools_in_a_round_with_other_agents(managed_env):
    app, client, node, project, planner, builder = managed_env
    _ready(app, node)
    thread_id = client.post(f"/api/v1/projects/{project['id']}/manager/conversation").json()['threadId']
    response = client.post(f"/api/v1/threads/{thread_id}/messages", json={
        'text': 'Plan and build', 'intent': 'accomplish',
        'addressAgentIds': [builder['id'], planner['id']], 'idempotencyKey': 'two-agents',
    })
    assert response.status_code == 202, response.text
    command = _take_command(app, node)
    request = app.state.daemon_store.active_run_request_for_session_any_node(thread_id)
    manifest = request['state']['_relay_collaboration_manifest']
    assert {a['agentId'] for a in manifest['assignments']} == {planner['id'], builder['id']}
    assert manifest['projectManager']['agentId'] == planner['id']
    if command['logicalAgentId'] == builder['id']:
        assert 'project_manager' not in command['state']
        _complete(app, node, command, thread_id)
        command = _take_command(app, node)
    assert command['logicalAgentId'] == planner['id']
    assert command['state']['project_manager']['agentId'] == planner['id']


def _run_task(env, body):
    app, client, node, project, *_ = env
    _ready(app, node)
    created = client.post("/api/v1/tasks", json={"projectId": project["id"], **body})
    assert created.status_code == 201, created.text
    started = client.post(f"/api/v1/tasks/{created.json()['id']}/runs", json={})
    assert started.status_code == 202, started.text
    assert started.json()["dispatch"]["state"] == "started", started.json()
    return _take_command(app, node)


def test_manager_brings_its_tools_to_its_own_task_runs(managed_env):
    _, _, _, project, planner, builder = managed_env
    command = _run_task(managed_env, {"title": "Groom the backlog", "assignedAgentId": planner["id"]})
    assert command["logicalAgentId"] == planner["id"]
    assert command["state"]["project_manager"] == {
        **command["state"]["project_manager"], "projectId": project["id"], "agentId": planner["id"],
    }
    assert _tool(managed_env, command, "overview").status_code == 200


def test_another_agents_task_run_gets_no_manager_tools(managed_env):
    _, _, _, _, _, builder = managed_env
    command = _run_task(managed_env, {"title": "Build the page", "assignedAgentId": builder["id"]})
    assert command["logicalAgentId"] == builder["id"]
    assert "project_manager" not in command["state"]
    assert _tool(managed_env, command, "overview").status_code == 403


def test_manager_brings_its_tools_to_its_own_automation_runs(managed_env):
    from automation_helpers import WEEKLY_TRIGGERS
    _, _, _, project, planner, _ = managed_env
    command = _run_task(managed_env, {
        "title": "Weekly status digest", "assignedAgentId": planner["id"],
        "isRoutine": True, "routineState": "active", "routineTriggers": WEEKLY_TRIGGERS,
    })
    assert command["logicalAgentId"] == planner["id"]
    assert command["state"]["project_manager"]["projectId"] == project["id"]


def test_a_setup_draft_by_the_manager_keeps_its_own_workflow(managed_env):
    app, client, node, project, planner, _ = managed_env
    _ready(app, node, setup=True)
    started = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Plan the launch", "agentId": planner["id"],
    })
    assert started.status_code == 202, started.text
    command = _take_command(app, node)
    assert command["logicalAgentId"] == planner["id"]
    assert "project_manager" not in command["state"]
