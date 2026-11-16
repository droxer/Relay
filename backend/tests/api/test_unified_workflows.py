"""Predefined and custom Workflows share one selection and default contract."""
from uuid import uuid4
from contextlib import contextmanager

import pytest

from test_team_workflows import workflow_world
from test_team_workflow_definitions import create_parent
from test_scheduled_workflows import tick



@contextmanager
def unified_world(monkeypatch):
    with workflow_world(monkeypatch) as world:
        app, _, node, *_ = world
        app.state.registry.register({**node, "protocolVersion": 1, "supportedAgents": ["codex", "claude"], "sandboxId": node["id"], "token": "token_node_here",
                                     "capabilities": [*node["capabilities"], "work-results"]})
        yield world


def setup_definitions(client, project, payload):
    team = create_parent(client, payload)
    workflow = client.post(f"/api/v1/teams/{team['id']}/workflows", json={
        'name': 'Delivery', 'projectId': project['id'],
        'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
    }).json()['workflow']
    response = client.patch(f"/api/v1/teams/{team['id']}", json={'defaultWorkflowId': workflow['id']})
    assert response.status_code == 200, response.text
    return response.json()['team'], workflow


def test_team_catalog_and_predefined_default(monkeypatch):
    with unified_world(monkeypatch) as (_, client, _, _, project, payload):
        team = create_parent(client, payload)
        assert team['defaultWorkflowId'] == 'preset:build_review'
        assert [item['kind'] for item in team['workflowOptions']] == ['predefined'] * 3
        response = client.patch(f"/api/v1/teams/{team['id']}", json={'defaultWorkflowId': 'preset:lead_led'})
        assert response.status_code == 200, response.text
        assert response.json()['team']['defaultWorkflowId'] == 'preset:lead_led'


@pytest.mark.parametrize('scheduled', [False, True])
@pytest.mark.parametrize('override', [False, True])
def test_task_inherits_custom_default_or_overrides_with_predefined(monkeypatch, scheduled, override):
    with unified_world(monkeypatch) as (app, client, _, _, project, payload):
        team, workflow = setup_definitions(client, project, payload)
        response = client.post('/api/v1/tasks', json={
            'title': 'Deliver', 'projectId': project['id'], 'assignedTeamId': team['id'],
            **({'assignedWorkflowId': 'preset:pipeline'} if override else {}),
            **({'status': 'assigned'} if scheduled else {}),
        })
        assert response.status_code == 201, response.text
        task = response.json()
        if scheduled:
            tick(app)
            task = app.state.task_store.get_task(task['id'])
            assert task['linkedSessionIds'], task
            session = app.state.session_store.get_session(task['linkedSessionIds'][0])
        else:
            response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
            assert response.status_code == 202, response.text
            session = response.json()['session']
            assert session is not None, response.text
        if override:
            assert not session.get('workflowRuns')
            snapshot = session['collaborationRounds'][0]['teamSnapshot']
            assert snapshot['workflowId'] == 'preset:pipeline'
            assert snapshot['collaborationStyle'] == 'pipeline'
        else:
            assert session['workflowRuns'][0]['teamSnapshot']['workflowId'] == workflow['id']
            assert session['workflowRuns'][0]['status'] == 'awaiting_approval'
        # Changing future defaults never changes an already frozen Run.
        before = session.get('workflowRuns') or session['collaborationRounds']
        assert client.patch(f"/api/v1/teams/{team['id']}", json={'defaultWorkflowId': 'preset:lead_led'}).status_code == 200
        current = app.state.session_store.get_session(session['id'])
        assert (current.get('workflowRuns') or current['collaborationRounds']) == before


def test_default_definition_cannot_be_deleted_or_disabled(monkeypatch):
    with unified_world(monkeypatch) as (_, client, _, _, project, payload):
        team, workflow = setup_definitions(client, project, payload)
        path = f"/api/v1/teams/{team['id']}/workflows/{workflow['id']}"
        assert client.delete(path).status_code == 409
        assert client.patch(path, json={'enabled': False}).status_code == 409
        assert client.patch(f"/api/v1/teams/{team['id']}", json={'defaultWorkflowId': 'preset:build_review'}).status_code == 200
        assert client.delete(path).status_code == 200


@pytest.mark.parametrize('workflow_id', ['preset:build_review', 'preset:pipeline', 'preset:lead_led'])
def test_predefined_run_selection_preserves_its_snapshot(monkeypatch, workflow_id):
    with unified_world(monkeypatch) as (_, client, _, _, _, payload):
        team = create_parent(client, payload)
        response = client.post('/api/v1/agent-runs', json={
            'taskGoal': 'Work together', 'teamId': team['id'], 'workflowId': workflow_id,
            'idempotencyKey': str(uuid4()),
        })
        assert response.status_code == 202, response.text
        assert response.json()['collaborationRounds'][0]['teamSnapshot']['workflowId'] == workflow_id


def test_predefined_starts_through_the_workflow_endpoint(monkeypatch):
    with unified_world(monkeypatch) as (_, client, _, _, _, payload):
        team = create_parent(client, payload)
        path = f"/api/v1/teams/{team['id']}/workflows/preset:pipeline/runs"
        body = {'requestId': str(uuid4()), 'taskGoal': 'Run the pipeline'}
        response = client.post(path, json=body)
        assert response.status_code == 201, response.text
        session = response.json()
        assert session['collaborationRounds'][0]['teamSnapshot']['workflowId'] == 'preset:pipeline'
        assert client.post(path, json=body).json()['id'] == session['id']
