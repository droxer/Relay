"""Predefined and custom Workflows share one selection and default contract."""
from uuid import uuid4
from contextlib import contextmanager

import pytest

from task_setup import mark_task_ready
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
def test_task_selects_its_project_workflow(monkeypatch, scheduled):
    with unified_world(monkeypatch) as (app, client, _, _, project, payload):
        agent_id = payload["workflowSteps"][0]["agentId"]
        profile = client.patch(f"/api/v1/agents/{agent_id}", json={"defaultRole": "tester", "roleLevel": "senior"})
        assert profile.status_code == 200, profile.text
        workflow = client.post('/api/v1/workflows', json={
            'name': 'Delivery', 'projectId': project['id'],
            'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        response = client.post('/api/v1/tasks', json={
            'title': 'Deliver', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
        })
        assert response.status_code == 201, response.text
        task = response.json()
        if scheduled:
            mark_task_ready(client, task)
            tick(app)
            task = app.state.task_store.get_task(task['id'])
            assert task['linkedSessionIds'], task
            session = app.state.session_store.get_session(task['linkedSessionIds'][0])
        else:
            response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
            assert response.status_code == 202, response.text
            session = response.json()['session']
            assert session is not None, response.text
        assert session['workflowRuns'][0]['teamSnapshot']['workflowId'] == workflow['id']
        assert session['workflowRuns'][0]['status'] == 'awaiting_approval'
        entry, = session['workflowRuns'][0]['assignments']
        assert (entry['role'], entry['roleLevel']) == ('tester', 'senior')
        assert not session.get('teamId')


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


@pytest.mark.parametrize('explicit', [False, True])
def test_new_team_conversation_starts_the_selected_custom_workflow(monkeypatch, explicit):
    with unified_world(monkeypatch) as (_, client, _, _, project, payload):
        team, workflow = setup_definitions(client, project, payload)
        body = {'taskGoal': 'Release from the team composer', 'teamId': team['id'],
                'idempotencyKey': str(uuid4()), 'userMessageId': 'opening-message', **({'workflowId': workflow['id']} if explicit else {})}
        response = client.post('/api/v1/agent-runs', json=body)
        assert response.status_code == 202, response.text
        session = response.json()
        assert session['projectId'] == project['id']
        assert session['workflowRuns'][0]['teamSnapshot']['workflowId'] == workflow['id']
        retried = client.post('/api/v1/agent-runs', json=body).json()
        assert retried['id'] == session['id']
        assert len([event for event in retried['events'] if event['type'] == 'user.message']) == 1
        assert next(event for event in retried['events'] if event['type'] == 'user.message')['id'] == 'opening-message'


def test_automation_selects_its_project_workflow(monkeypatch):
    from datetime import UTC, datetime, timedelta
    from automation_helpers import DAILY_TRIGGERS
    from test_scheduled_workflows import occurrence_of
    with unified_world(monkeypatch) as (app, client, _, _, project, payload):
        workflow = client.post('/api/v1/workflows', json={
            'name': 'Delivery', 'projectId': project['id'],
            'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        routine = client.post('/api/v1/tasks', json={
            'title': 'Nightly', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
            'isRoutine': True, 'routineState': 'active', 'routineTriggers': DAILY_TRIGGERS,
        }).json()
        app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2))
        occurrence = occurrence_of(app, routine['id'])
        tick(app)
        occurrence = app.state.task_store.get_task(occurrence['id'])
        assert occurrence['linkedSessionIds'], occurrence
        session = app.state.session_store.get_session(occurrence['linkedSessionIds'][0])
        assert session['workflowRuns'][0]['teamSnapshot']['workflowId'] == workflow['id']
        assert not session.get('teamId')


def test_legacy_workflow_team_can_adopt_a_predefined_default_without_losing_steps(monkeypatch):
    with unified_world(monkeypatch) as (_, client, _, _, _, payload):
        legacy = client.post('/api/v1/teams', json=payload).json()['team']
        response = client.patch(f"/api/v1/teams/{legacy['id']}", json={'defaultWorkflowId': 'preset:pipeline'})
        assert response.status_code == 200, response.text
        team = response.json()['team']
        assert 'workflowSteps' not in team
        assert team['workflows'][0]['workflowSteps'] == legacy['workflowSteps']
        run = client.post('/api/v1/agent-runs', json={'taskGoal': 'Pipeline', 'teamId': team['id']})
        assert run.status_code == 202, run.text
        assert run.json()['collaborationRounds'][0]['teamSnapshot']['workflowId'] == 'preset:pipeline'


@pytest.mark.parametrize('invalid', ['id', 'missing', 'attachment', 'assignments', 'project', 'computer', 'service'])
def test_custom_conversation_entry_rejects_overrides_and_nonowner_actors(monkeypatch, invalid):
    from fastapi.testclient import TestClient
    with unified_world(monkeypatch) as (app, client, node, _, project, payload):
        team, workflow = setup_definitions(client, project, payload)
        body = {'taskGoal': 'Do not dispatch', 'teamId': team['id'], 'workflowId': workflow['id']}
        if invalid == 'id':
            body['workflowId'] = ''
        elif invalid == 'missing':
            body['workflowId'] = 'missing-definition'
        elif invalid == 'attachment':
            body['attachmentIds'] = ['attachment']
        elif invalid == 'assignments':
            body['assignments'] = []
        elif invalid == 'project':
            body['projectId'] = 'foreign'
        elif invalid == 'computer':
            body['daemonNodeId'] = 'other'
        else:
            client = TestClient(app)
            client.headers.update({'Authorization': 'Bearer chat-test', 'x-relay-user-id': team['ownerUserId']})
        response = client.post('/api/v1/agent-runs', json=body)
        assert response.status_code in (400, 403, 409), response.text
        assert app.state.registry.take_commands(node['id'], 'token_node_here') == []


def _count_outcomes(monkeypatch, store):
    recorded = []
    original = store.record_dispatch_outcome

    def spy(task_id, state, **kwargs):
        recorded.append((task_id, state, kwargs.get('code')))
        return original(task_id, state, **kwargs)

    monkeypatch.setattr(store, 'record_dispatch_outcome', spy)
    return recorded


def test_projectless_task_inheriting_a_custom_default_blocks_once(monkeypatch):
    from relay.core.computer_identity import computer_id
    with unified_world(monkeypatch) as (app, client, node, _, project, payload):
        team = create_parent(client, payload)
        response = client.post('/api/v1/tasks', json={
            'title': 'Ad hoc', 'assignedTeamId': team['id'], 'computerId': computer_id(node),
        })
        assert response.status_code == 201, response.text
        task = response.json()
        # The default changes after the task already inherits it.
        setup_definitions_for(client, team, project, payload)
        app.state.task_store.update_task(task['id'], {'status': 'assigned'})
        recorded = _count_outcomes(monkeypatch, app.state.task_store)
        for _ in range(3):
            tick(app)
        current = app.state.task_store.get_task(task['id'])
        assert current['status'] == 'blocked', current
        assert current['dispatchOutcome']['code'] == 'team_workflow_project_mismatch'
        assert len(recorded) <= 1, recorded


def test_offline_workflow_computer_records_its_wait_once(monkeypatch):
    with unified_world(monkeypatch) as (app, client, _, _, project, payload):
        workflow = client.post('/api/v1/workflows', json={
            'name': 'Delivery', 'projectId': project['id'],
            'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        task = client.post('/api/v1/tasks', json={
            'title': 'Deliver', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
        }).json()
        mark_task_ready(client, task)
        monkeypatch.setattr('relay.tasks.workflow.dispatch.project_runtime_node', lambda *_: None)
        recorded = _count_outcomes(monkeypatch, app.state.task_store)
        for _ in range(3):
            tick(app)
        current = app.state.task_store.get_task(task['id'])
        assert current['status'] == 'assigned', current
        assert current['dispatchOutcome'] == {
            'state': 'queued', 'code': 'workflow_computer_unavailable', 'message': 'workflow_computer_unavailable',
        }
        assert len(recorded) == 1, recorded


def setup_definitions_for(client, team, project, payload):
    workflow = client.post(f"/api/v1/teams/{team['id']}/workflows", json={
        'name': 'Delivery', 'projectId': project['id'], 'workflowSteps': payload['workflowSteps'],
    }).json()['workflow']
    response = client.patch(f"/api/v1/teams/{team['id']}", json={'defaultWorkflowId': workflow['id']})
    assert response.status_code == 200, response.text
    return workflow


def test_team_thread_keeps_its_predefined_workflow_after_a_custom_default(monkeypatch):
    with unified_world(monkeypatch) as (app, client, node, _, project, payload):
        team = create_parent(client, payload)
        started = client.post('/api/v1/agent-runs', json={
            'taskGoal': 'Talk it through', 'teamId': team['id'], 'workflowId': 'preset:pipeline',
            'idempotencyKey': str(uuid4()),
        })
        assert started.status_code == 202, started.text
        session = started.json()
        _drain_runs(client, node, session['id'])
        setup_definitions_for(client, team, project, payload)
        response = client.post(f"/api/v1/threads/{session['id']}/messages", json={
            'text': 'And the follow-up', 'intent': 'accomplish', 'idempotencyKey': str(uuid4()),
        })
        assert response.status_code == 202, response.text
        rounds = app.state.session_store.get_session(session['id'])['collaborationRounds']
        assert {item['teamSnapshot']['workflowId'] for item in rounds} == {'preset:pipeline'}


def _drain_runs(client, node, session_id):
    """Lease and complete every queued run so the thread is idle again."""
    headers = {'Authorization': 'Bearer token_node_here'}
    for _ in range(8):
        commands = client.get(f"/api/v1/daemon-nodes/{node['id']}/commands?leaseMode=explicit&leaseSeconds=10",
                              headers=headers).json()['commands']
        runs = [command for command in commands if command.get('runId')]
        if not runs:
            return
        for command in runs:
            response = client.post(f"/api/v1/daemon-nodes/{node['id']}/events", headers=headers, json={
                'type': 'run.completed', 'commandId': command['id'], 'leaseId': command['leaseId'],
                'sessionId': session_id, 'runId': command['runId'], 'agent': command['agent'],
                'exitCode': 0, 'agentLog': 'Done.',
            })
            assert response.status_code == 200, response.text
