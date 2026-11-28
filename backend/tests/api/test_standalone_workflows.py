"""Computer-bound workflows run independent Tasks without a Team or Project."""
from contextlib import contextmanager
from uuid import uuid4

import asyncio
import pytest
from fastapi.testclient import TestClient

from relay.core.computer_identity import computer_id

from test_team_computer import _world, _agent, _sync
from issue_projects import project_for_agents
from task_setup import mark_task_ready


@contextmanager
def standalone_world(monkeypatch):
    with _world(monkeypatch) as (app, client, here, there):
        here = app.state.registry.register({
            **here, 'sandboxId': here['id'], 'token': 'token_node_here',
            'protocolVersion': 1, 'supportedAgents': ['codex', 'claude'],
            'capabilities': [*here['capabilities'], 'task-workspaces', 'round-result', 'workflow-results'],
        })
        agent = _agent(app, here, 'Builder')
        _sync(app, here, there)
        body = {
            'name': 'Independent delivery', 'computerId': computer_id(here),
            'workflowSteps': [{
                'id': 'build', 'name': 'Build', 'agentId': agent['id'],
                'instructions': 'Build the requested result', 'acceptanceCriteria': ['Works'],
                'requiresApproval': True,
            }],
        }
        yield app, client, here, there, agent, body


def create_definition(client, body):
    response = client.post('/api/v1/workflows', json=body)
    assert response.status_code == 201, response.text
    return response.json()['workflow']


def test_standalone_definition_lifecycle_and_choices(monkeypatch):
    with standalone_world(monkeypatch) as (app, client, _, _, _, body):
        workflow = create_definition(client, body)
        assert client.post('/api/v1/workflows', json=body).status_code == 409
        assert not workflow.get('projectId') and not workflow.get('ownerTeamId')
        assert workflow['computerId'] == body['computerId']
        response = client.get('/api/v1/workflows?scope=standalone&view=choices')
        assert response.status_code == 200
        assert response.json()['workflows'][0]['id'] == workflow['id']
        assert response.json()['workflows'][0]['computerId'] == body['computerId']
        assert client.get('/api/v1/workflows?view=choices').json()['workflows'] == []
        assert app.state.team_store.list_teams() == []
        assert app.state.project_store.list_projects() == []
        path = '/api/v1/workflows/' + workflow['id']
        changed = client.patch(path, json={'name': 'Renamed', 'expectedVersion': workflow['version']})
        assert changed.status_code == 200, changed.text
        assert client.patch(path, json={'name': 'Stale', 'expectedVersion': workflow['version']}).status_code == 409
        assert client.get(path).json()['workflow']['name'] == 'Renamed'
        assert client.delete(path).status_code == 200
        assert client.get(path).status_code == 404


@pytest.mark.parametrize('entry', ['manual', 'scheduled'])
def test_standalone_task_starts_and_approves_in_task_workspace(monkeypatch, entry):
    with standalone_world(monkeypatch) as (app, client, here, _, _, body):
        workflow = create_definition(client, body)
        response = client.post('/api/v1/tasks', json={
            'title': 'Run without a Project', 'computerId': body['computerId'],
            'assignedWorkflowId': workflow['id'],
        })
        assert response.status_code == 201, response.text
        task = response.json()
        if entry == 'scheduled':
            mark_task_ready(client, task)
            asyncio.run(app.state.task_scheduler.tick())
            stored = app.state.task_store.get_task(task['id'])
            assert stored['status'] == 'waiting_for_human', stored
            session = app.state.session_store.get_session(stored['linkedSessionIds'][0])
        else:
            started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
            assert started.status_code == 202, started.text
            assert started.json()['dispatch']['state'] == 'started', started.text
            session = started.json()['session']
        assert not session.get('projectId') and not session.get('teamId')
        assert session['workspaceLayout'] == 'task'
        assert session['workspaceSubpath'] == f"tasks/{task['id']}"
        run = session['workflowRuns'][0]
        assert run['status'] == 'awaiting_approval'
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []
        first = run['assignments'][0]
        decision = {key: first[key] for key in ('workflowRunId', 'workflowStepId', 'workflowAttempt', 'assignmentId')}
        approved = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json={
            **decision, 'expectedRevision': run['revision'], 'kind': 'approve',
        })
        assert approved.status_code == 200, approved.text
        commands = app.state.registry.take_commands(here['id'], 'token_node_here')
        assert len(commands) == 1
        assert commands[0]['type'] == 'run.start'
        assert app.state.team_store.list_teams() == []
        assert app.state.project_store.list_projects() == []
        stored = app.state.task_store.get_task(task['id'])
        assert stored['workspaceBinding']['subpath'] == session['workspaceSubpath']
        assert client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json={
            **decision, 'expectedRevision': run['revision'], 'kind': 'approve',
        }).status_code == 409


def test_standalone_definition_and_assignment_fail_closed(monkeypatch):
    with standalone_world(monkeypatch) as (app, client, _, there, agent, body):
        assert TestClient(app).post('/api/v1/workflows', json=body).status_code == 401
        assert client.post('/api/v1/workflows', json={**body, 'computerId': computer_id(there)}).status_code == 400
        workflow = create_definition(client, body)
        conflicting = {'title': 'Conflict', 'assignedWorkflowId': workflow['id']}
        assert client.post('/api/v1/tasks', json={**conflicting, 'assignedAgentId': agent['id']}).status_code == 409
        assert client.post('/api/v1/tasks', json={**conflicting, 'computerId': computer_id(there)}).status_code == 409
        assert client.patch('/api/v1/workflows/' + workflow['id'], json={'enabled': False}).status_code == 200
        assert client.post('/api/v1/tasks', json=conflicting).status_code == 409


@pytest.mark.parametrize('lost', ['agent', 'workspace'])
def test_standalone_approval_rechecks_agent_and_workspace(monkeypatch, lost):
    with standalone_world(monkeypatch) as (app, client, here, _, agent, body):
        workflow = create_definition(client, body)
        task_response = client.post('/api/v1/tasks', json={
            'title': 'Keep the gate closed', 'computerId': body['computerId'],
            'assignedWorkflowId': workflow['id'],
        })
        assert task_response.status_code == 201, task_response.text
        task = task_response.json()
        response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert response.status_code == 202, response.text
        session = response.json()['session']
        run = session['workflowRuns'][0]
        first = run['assignments'][0]
        decision = {key: first[key] for key in ('workflowRunId', 'workflowStepId', 'workflowAttempt', 'assignmentId')}
        if lost == 'agent':
            app.state.agent_store.update_agent(agent['id'], {'enabled': False})
        else:
            app.state.registry.register({
                **here, 'sandboxId': here['id'], 'token': 'token_node_here', 'protocolVersion': 1,
                'workspacePath': '/workspace/moved', 'supportedAgents': ['codex', 'claude'],
            })
        path = f"/api/v1/threads/{session['id']}/workflow-decisions"
        rejected = client.post(path, json={**decision, 'expectedRevision': run['revision'], 'kind': 'approve'})
        assert rejected.status_code == 409, rejected.text
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []
        restored = app.state.session_store.get_session(session['id'])
        assert restored['workflowRuns'][0]['revision'] == run['revision']
        # Losing admission cannot remove the owner's exit.
        cancelled = client.post(path, json={**decision, 'expectedRevision': run['revision'], 'kind': 'cancel'})
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()['workflowRuns'][0]['status'] == 'cancelled'


def test_standalone_scope_cannot_be_replaced_by_a_project(monkeypatch):
    with standalone_world(monkeypatch) as (app, client, _, _, agent, body):
        workflow = create_definition(client, body)
        project = project_for_agents(app.state.project_store, workflow['ownerUserId'], [agent])
        response = client.post(f"/api/v1/workflows/{workflow['id']}/runs", json={
            'requestId': str(uuid4()), 'taskGoal': 'Borrow another execution scope', 'projectId': project['id'],
        })
        assert response.status_code == 409, response.text
        assert response.json()['detail'] == 'workflow_project_scope_required'
        response = client.post('/api/v1/tasks', json={
            'title': 'Project cannot adopt the definition', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
        })
        assert response.status_code == 409, response.text
        unchanged = client.get(f"/api/v1/workflows/{workflow['id']}").json()['workflow']
        assert unchanged == workflow
