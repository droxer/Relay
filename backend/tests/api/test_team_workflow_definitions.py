"""A Team owns several reusable definitions without changing its roster."""
import pytest
from fastapi.testclient import TestClient

from test_team_workflows import workflow_world


def create_parent(client, payload):
    return client.post('/api/v1/teams', json={
        key: value for key, value in payload.items() if key not in {'projectId', 'workflowSteps'}
    }).json()['team']


def test_multiple_workflows_leave_roster_and_policy_unchanged(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        definitions = []
        for name in ('Build feature', 'Fix bug'):
            response = client.post(path, json={
                'name': name, 'projectId': project['id'], 'workflowSteps': payload['workflowSteps'],
            })
            assert response.status_code == 201, response.text
            definitions.append(response.json()['workflow'])
        assert definitions[0]['id'] != definitions[1]['id']
        assert all(item['teamId'] == parent['id'] for item in definitions)
        current = app.state.team_store.get_team(parent['id'])
        for key in ('memberAgentIds', 'leadAgentId', 'collaborationStyle'):
            assert current.get(key) == parent.get(key)
        assert 'workflowSteps' not in current
        assert client.get(path).json()['workflows'] == definitions
        changed = client.patch(path + '/' + definitions[0]['id'], json={'name': 'Feature delivery'})
        assert changed.status_code == 200, changed.text
        assert client.get(path).json()['workflows'][1] == definitions[1]
        assert client.delete(path + '/' + definitions[0]['id']).status_code == 200
        assert client.get(path).json()['workflows'] == [definitions[1]]
        assert app.state.team_store.get_team(parent['id'])['enabled']


def test_invalid_definition_and_service_actor_cannot_write(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        body = {'name': 'Build', 'projectId': project['id'], 'workflowSteps': payload['workflowSteps']}
        before = app.state.team_store.events(parent['id'])
        for patch in ({'teamId': 'other'}, {'workflowSteps': []}, {'enabled': 'yes'},
                      {'workflowSteps': [{**payload['workflowSteps'][0], 'agentId': 'outsider'}]}):
            response = client.post(path, json={**body, **patch})
            assert response.status_code == 400, response.text
        service = TestClient(app)
        service.headers.update({'Authorization': 'Bearer chat-test', 'x-relay-user-id': parent['ownerUserId']})
        assert service.post(path, json=body).status_code == 403
        assert app.state.team_store.events(parent['id']) == before


def test_runs_freeze_selected_workflow_and_are_idempotent_per_definition(monkeypatch):
    from uuid import uuid4
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        steps = [{**payload['workflowSteps'][0], 'requiresApproval': True}]
        workflows = [client.post(path, json={
            'name': name, 'projectId': project['id'], 'workflowSteps': steps,
        }).json()['workflow'] for name in ('Build', 'Fix')]
        body = {'requestId': str(uuid4()), 'taskGoal': 'Do work'}
        runs = []
        for workflow in workflows:
            run_path = path + '/' + workflow['id'] + '/runs'
            response = client.post(run_path, json=body)
            assert response.status_code == 201, response.text
            run = response.json()
            runs.append(run)
            snapshot = run['workflowRuns'][0]['teamSnapshot']
            assert run['teamId'] == parent['id']
            assert snapshot['workflowId'] == workflow['id']
            assert snapshot['name'] == workflow['name']
            assert client.post(run_path, json=body).json()['id'] == run['id']
            assert client.patch(path + '/' + workflow['id'], json={'name': workflow['name'] + ' updated'}).status_code == 200
            assert app.state.session_store.get_session(run['id'])['workflowRuns'][0]['teamSnapshot'] == snapshot
        assert runs[0]['id'] != runs[1]['id']
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []


def test_task_selects_a_project_workflow_without_a_team(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        workflow = client.post('/api/v1/workflows', json={
            'name': 'Feature', 'projectId': project['id'],
            'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        response = client.post('/api/v1/tasks', json={
            'title': 'Feature task', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
        })
        assert response.status_code == 201, response.text
        task = response.json()
        assert task['assignedWorkflowId'] == workflow['id']
        assert not task.get('assignedTeamId')
        response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert response.status_code == 202, response.text
        session = response.json()['session']
        assert session['workflowRuns'][0]['teamSnapshot']['workflowId'] == workflow['id']
        assert not session.get('teamId')


def test_task_workflow_can_be_changed_cleared_and_rejects_foreign_scope(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        workflows = [client.post('/api/v1/workflows', json={
            'name': name, 'projectId': project['id'], 'workflowSteps': payload['workflowSteps'],
        }).json()['workflow'] for name in ('Build', 'Fix')]
        task = client.post('/api/v1/tasks', json={
            'title': 'Choose process', 'projectId': project['id'],
            'assignedWorkflowId': workflows[0]['id'],
        }).json()
        for workflow in workflows:
            response = client.patch(f"/api/v1/tasks/{task['id']}", json={'assignedWorkflowId': workflow['id']})
            assert response.status_code == 200, response.text
            assert response.json()['assignedWorkflowId'] == workflow['id']
        response = client.patch(f"/api/v1/tasks/{task['id']}", json={'assignedWorkflowId': None})
        assert response.status_code == 200, response.text
        assert not response.json().get('assignedWorkflowId')
        # A Project Task still names only its own Project's Workflow.
        from issue_projects import project_for_agents
        other = project_for_agents(app.state.project_store, project['ownerUserId'],
                                   [app.state.agent_store.get_agent(project['leadAgentId'])], name='Other project')
        foreign = client.post('/api/v1/workflows', json={
            'name': 'Foreign', 'projectId': other['id'], 'workflowSteps': payload['workflowSteps'],
        }).json()['workflow']
        response = client.post('/api/v1/tasks', json={
            'title': 'Wrong scope', 'projectId': project['id'],
            'assignedWorkflowId': foreign['id'],
        })
        assert response.status_code == 409, response.text
        assert 'team_workflow_project_mismatch' in response.text


def test_disabled_definitions_can_be_edited_and_enabled_again(monkeypatch):
    from uuid import uuid4
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        response = client.post(path, json={
            'name': 'Draft', 'projectId': project['id'], 'workflowSteps': payload['workflowSteps'], 'enabled': False,
        })
        assert response.status_code == 201, response.text
        path += '/' + response.json()['workflow']['id']
        assert client.post(path + '/runs', json={'requestId': str(uuid4()), 'taskGoal': 'Work'}).status_code == 409
        assert client.patch(path, json={'name': 'Ready', 'enabled': True}).status_code == 200
        assert client.patch(path, json={'enabled': False}).status_code == 200


@pytest.mark.parametrize("team_change", [None, "disabled", "deleted", "removed_member"])
def test_frozen_run_survives_definition_deletion_but_requires_live_team(monkeypatch, team_change):
    from uuid import uuid4
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        parent = create_parent(client, payload)
        path = f"/api/v1/teams/{parent['id']}/workflows"
        workflow = client.post(path, json={
            'name': 'Build', 'projectId': project['id'],
            'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        run = client.post(path + '/' + workflow['id'] + '/runs', json={
            'requestId': str(uuid4()), 'taskGoal': 'Build it',
        }).json()
        assert client.delete(path + '/' + workflow['id']).status_code == 200
        if team_change == 'disabled':
            app.state.team_store.update_team(parent['id'], {'enabled': False})
        elif team_change == 'deleted':
            app.state.team_store.delete_team(parent['id'])
        elif team_change == 'removed_member':
            app.state.team_store.remove_member(parent['id'], payload['leadAgentId'])
        first = run['workflowRuns'][0]['assignments'][0]
        decision = {key: first[key] for key in ('workflowRunId', 'workflowStepId', 'workflowAttempt', 'assignmentId')}
        response = client.post(f"/api/v1/threads/{run['id']}/workflow-decisions", json={
            **decision, 'kind': 'approve', 'expectedRevision': 0,
        })
        assert response.status_code == (409 if team_change else 200), response.text
        assert len(app.state.registry.take_commands(here['id'], 'token_node_here')) == (0 if team_change else 1)


@pytest.mark.parametrize('entry', ['task', 'automation'])
def test_scheduler_preserves_selected_workflow(monkeypatch, entry):
    from datetime import UTC, datetime, timedelta
    from automation_helpers import DAILY_TRIGGERS
    from test_scheduled_workflows import tick, workflow_session, occurrence_of
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        workflow = client.post('/api/v1/workflows', json={
            'name': 'Scheduled build', 'projectId': project['id'],
            'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        task = client.post('/api/v1/tasks', json={
            'title': 'Scheduled work', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
            **({'isRoutine': True, 'routineState': 'active', 'routineTriggers': DAILY_TRIGGERS}
               if entry == 'automation' else {'status': 'assigned'}),
        }).json()
        if entry == 'automation':
            app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2))
            task = occurrence_of(app, task['id'])
        tick(app)
        current, session = workflow_session(app, task['id'])
        assert current['assignedWorkflowId'] == workflow['id']
        assert current['status'] == 'waiting_for_human'
        assert session['workflowRuns'][0]['teamSnapshot']['workflowId'] == workflow['id']
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []
