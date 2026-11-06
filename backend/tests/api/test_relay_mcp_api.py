"""MCP uses revocable scoped API tokens, never a browser or daemon credential."""
from fastapi.testclient import TestClient
import test_project_setup_api as setup_api

setup_env=setup_api.setup_env


def _token(client, project):
    response=client.post('/api/v1/mcp/tokens',json={'name':'Local agent','projectIds':[project['id']]})
    assert response.status_code == 201,response.text
    return response.json()


def test_mcp_token_reads_its_project_and_is_never_revealed_again(setup_env):
    app,client,node,project,*_=setup_env
    grant=_token(client,project)
    assert grant['token'].startswith('relay_mcp_')
    external=TestClient(app)
    headers={'Authorization':f"Bearer {grant['token']}"}
    projects=external.get('/api/v1/mcp/projects',headers=headers)
    assert projects.status_code == 200,projects.text
    assert [p['id'] for p in projects.json()['projects']] == [project['id']]
    overview=external.post(f"/api/v1/mcp/projects/{project['id']}/tools",headers=headers,json={'tool':'overview','arguments':{}})
    assert overview.status_code == 200,overview.text
    assert overview.json()['project']['id'] == project['id']
    listed=client.get('/api/v1/mcp/tokens').json()['tokens']
    assert all('token' not in row and 'tokenHash' not in row for row in listed)
    assert grant['token'] not in str(app.state.project_store.get_project(project['id']))
    client.delete(f"/api/v1/mcp/tokens/{grant['id']}")
    assert external.get('/api/v1/mcp/projects',headers=headers).status_code == 401


def test_mcp_scope_cannot_escape_and_proposals_need_owner_apply(setup_env):
    app,client,node,project,*_=setup_env
    grant=_token(client,project)
    external=TestClient(app)
    headers={'Authorization':f"Bearer {grant['token']}"}
    other=client.post('/api/v1/projects',json={'name':'Other project','daemonNodeId':node['id'],'members':[]}).json()['project']
    assert external.post(f"/api/v1/mcp/projects/{other['id']}/tools",headers=headers,json={'tool':'overview'}).status_code == 403
    staged=external.post(f"/api/v1/mcp/projects/{project['id']}/tools",headers=headers,json={'tool':'propose','arguments':{'operations':[{'kind':'create','fields':{'title':'Via MCP'}}]}})
    assert staged.status_code == 200,staged.text
    proposal=staged.json()['proposal']
    assert proposal['source'] == 'mcp'
    assert proposal['runId'] is None
    url=f"/api/v1/projects/{project['id']}/manager/proposals/{proposal['id']}/apply"
    assert external.post(url,headers=headers,json={'idempotencyKey':'agent-cannot-apply'}).status_code == 401
    assert client.get('/api/v1/tasks').json()['tasks'] == []
    applied=client.post(url,json={'idempotencyKey':'owner-applies'})
    assert applied.status_code == 200,applied.text
    assert applied.json()['tasks'][0]['status'] == 'backlog'


def test_computer_mcp_tokens_follow_computer_ownership_and_run_lifetime(setup_env):
    from test_project_manager_api import _start
    app, client, node, project, *_ = setup_env
    external = TestClient(app)
    url = f"/api/v1/daemon-nodes/{node['id']}/mcp-token"
    assert external.post(url, json={}).status_code == 401
    headers = {"Authorization": f"Bearer token_{node['id']}"}
    issued = external.post(url, headers=headers, json={})
    assert issued.status_code == 201, issued.text
    auth = {"Authorization": f"Bearer {issued.json()['token']}"}
    assert external.get('/api/v1/mcp/projects', headers=auth).status_code == 200
    result, command = _start(setup_env)
    issued = external.post(url, headers=headers, json={"commandId": command['id'], "leaseId": command['leaseId']})
    assert issued.status_code == 201, issued.text
    run_auth = {"Authorization": f"Bearer {issued.json()['token']}"}
    assert external.get('/api/v1/mcp/projects', headers=run_auth).status_code == 200
    other = client.post('/api/v1/projects', json={'name':'Other scope','daemonNodeId':node['id'],'members':[]}).json()['project']
    refused = external.post(f"/api/v1/mcp/projects/{other['id']}/tools", headers=run_auth,json={'tool':'overview'})
    assert refused.status_code == 403, refused.text
    staged = external.post(f"/api/v1/mcp/projects/{project['id']}/tools",headers=run_auth,json={
        'tool':'propose','arguments':{'operations':[{'kind':'create','fields':{'title':'Run attributed'}}]},
    })
    assert staged.status_code == 200, staged.text
    assert staged.json()['proposal']['agentId'] == command['logicalAgentId']
    assert staged.json()['proposal']['runId'] == command['runId']
    assert staged.json()['proposal']['threadId'] == command['sessionId']
    setup_api._complete(app, node, command, result['threadId'])
    assert external.get('/api/v1/mcp/projects', headers=run_auth).status_code == 401
    assert external.get('/api/v1/mcp/projects', headers=auth).status_code == 200


def test_expired_mcp_token_and_foreign_revocation_are_rejected(setup_env):
    from datetime import datetime, timedelta, UTC
    from sqlalchemy import update
    from relay.persistence.tables.mcp import mcp_tokens
    app, client, _, project, *_ = setup_env
    token = _token(client, project)
    client.post("/api/v1/auth/logout")
    assert client.post("/api/v1/auth/login", json={"username": "admin", "password": "kestrel-vault-7719"}).status_code == 200
    assert client.delete(f"/api/v1/mcp/tokens/{token['id']}").status_code == 404
    with app.state.project_store.engine.begin() as connection:
        connection.execute(update(mcp_tokens).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    external = TestClient(app)
    assert external.get('/api/v1/mcp/projects', headers={"Authorization": f"Bearer {token['token']}"}).status_code == 401


def test_computer_renews_expired_token_but_never_revives_revocation(setup_env):
    from datetime import datetime, timedelta, UTC
    from sqlalchemy import update
    from relay.persistence.tables.mcp import mcp_tokens
    app,client,node,*_ = setup_env
    daemon = TestClient(app)
    url = f"/api/v1/daemon-nodes/{node['id']}/mcp-token"
    headers = {'Authorization':f"Bearer token_{node['id']}"}
    original = daemon.post(url,headers=headers,json={}).json()
    healthy = daemon.post(url,headers=headers,json={'existingToken':original['token']})
    assert healthy.status_code == 201,healthy.text
    assert healthy.json()['id'] == original['id']
    assert healthy.json()['renewed'] is False
    assert 'token' not in healthy.json()
    with app.state.project_store.engine.begin() as connection:
        connection.execute(update(mcp_tokens).where(mcp_tokens.c.id == original['id']).values(expires_at=datetime.now(UTC)-timedelta(seconds=1)))
    renewed = daemon.post(url,headers=headers,json={'existingToken':original['token']})
    assert renewed.status_code == 201,renewed.text
    assert renewed.json()['id'] != original['id']
    assert renewed.json()['token'] != original['token']
    client.delete(f"/api/v1/mcp/tokens/{renewed.json()['id']}")
    blocked = daemon.post(url,headers=headers,json={'existingToken':renewed.json()['token']})
    assert blocked.status_code == 403,blocked.text
    assert blocked.json()['detail'] == 'mcp_token_revoked'
