"""Project processes have a lifecycle independent of optional Team references."""
from uuid import uuid4

from task_setup import mark_task_ready
from test_team_workflows import workflow_world
from test_team_workflow_definitions import create_parent


def definition(client, project, payload, name="Project delivery"):
    response = client.post('/api/v1/workflows', json={
        'name': name, 'projectId': project['id'],
        'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
    })
    assert response.status_code == 201, response.text
    return response.json()['workflow']


def test_project_workflow_runs_without_creating_a_team(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        before = app.state.team_store.list_teams()
        workflow = definition(client, project, payload)
        assert client.get(f"/api/v1/workflows?projectId={project['id']}").json()['workflows'] == [workflow]
        body = {'requestId': str(uuid4()), 'taskGoal': 'Ship the Project'}
        path = f"/api/v1/workflows/{workflow['id']}/runs"
        response = client.post(path, json=body)
        assert response.status_code == 201, response.text
        session = response.json()
        assert not session.get('teamId')
        assert session['projectId'] == project['id']
        assert session['workflowRuns'][0]['status'] == 'awaiting_approval'
        assert client.post(path, json=body).json()['id'] == session['id']
        assert app.state.team_store.list_teams() == before


def test_team_links_do_not_own_or_copy_the_definition(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        workflow = definition(client, project, payload)
        teams = [create_parent(client, {**payload, 'name': name}) for name in ('Delivery', 'Review')]
        for team in teams:
            path = f"/api/v1/teams/{team['id']}/workflows/{workflow['id']}/link"
            assert client.put(path, json={}).status_code == 200
            assert client.get(f"/api/v1/teams/{team['id']}/workflows").json()['workflows'][0]['id'] == workflow['id']
        assert client.delete(f"/api/v1/teams/{teams[0]['id']}").status_code == 200
        assert client.get(f"/api/v1/workflows/{workflow['id']}").json()['workflow']['name'] == workflow['name']
        assert client.delete(f"/api/v1/teams/{teams[1]['id']}/workflows/{workflow['id']}/link").status_code == 200
        run = client.post(f"/api/v1/workflows/{workflow['id']}/runs", json={
            'requestId': str(uuid4()), 'taskGoal': 'Work independently',
        })
        assert run.status_code == 201, run.text
        assert not run.json().get('teamId')


def test_task_can_select_a_workflow_without_a_team(monkeypatch):
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        workflow = definition(client, project, payload)
        response = client.post('/api/v1/tasks', json={
            'title': 'Independent work', 'projectId': project['id'], 'assignedWorkflowId': workflow['id'],
        })
        assert response.status_code == 201, response.text
        task = response.json()
        assert task['assignedWorkflowId'] == workflow['id']
        assert not task.get('assignedTeamId')
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert started.status_code == 202, started.text
        assert not started.json()['session'].get('teamId')
        assert started.json()['session']['workflowRuns'][0]['status'] == 'awaiting_approval'


def test_disabled_and_foreign_scope_refuse_standalone_dispatch(monkeypatch):
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        workflow = definition(client, project, payload)
        path = f"/api/v1/workflows/{workflow['id']}"
        assert client.patch(path, json={'enabled': False}).status_code == 200
        assert client.post(path + '/runs', json={'requestId': str(uuid4()), 'taskGoal': 'No'}).status_code == 409
        assert client.post('/api/v1/tasks', json={'title': 'No Project', 'assignedWorkflowId': workflow['id']}).status_code in (400, 409)


def test_legacy_definition_identity_survives_team_deletion(monkeypatch):
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        team = client.post('/api/v1/teams', json=payload).json()['team']
        workflow = client.get(f"/api/v1/workflows/{team['id']}")
        assert workflow.status_code == 200, workflow.text
        assert workflow.json()['workflow']['projectId'] == project['id']
        assert client.delete(f"/api/v1/teams/{team['id']}").status_code == 200
        assert client.get(f"/api/v1/workflows/{team['id']}").status_code == 200


def test_independent_owner_approval_admits_without_team(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        workflow = definition(client, project, payload)
        session = client.post(f"/api/v1/workflows/{workflow['id']}/runs", json={
            'requestId': str(uuid4()), 'taskGoal': 'Approve independent work',
        }).json()
        first = session['workflowRuns'][0]['assignments'][0]
        binding = {key: first[key] for key in ('workflowRunId', 'workflowStepId', 'workflowAttempt', 'assignmentId')}
        response = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json={
            **binding, 'expectedRevision': 0, 'kind': 'approve',
        })
        assert response.status_code == 200, response.text
        assert len(app.state.registry.take_commands(here['id'], 'token_node_here')) == 1


def test_scheduler_dispatches_standalone_task_and_automation(monkeypatch):
    import asyncio
    from datetime import UTC, datetime, timedelta
    from automation_helpers import DAILY_TRIGGERS
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        workflow = definition(client, project, payload)
        task = client.post('/api/v1/tasks', json={
            'title': 'Scheduled workflow', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
        }).json()
        mark_task_ready(client, task)
        asyncio.run(app.state.task_scheduler.tick())
        assert app.state.task_store.get_task(task['id'])['status'] == 'waiting_for_human'
        routine = client.post('/api/v1/tasks', json={
            'title': 'Automated workflow', 'projectId': project['id'], 'assignedWorkflowId': workflow['id'],
            'isRoutine': True, 'routineState': 'active', 'routineTriggers': DAILY_TRIGGERS,
        })
        assert routine.status_code == 201, routine.text
        app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2))
        asyncio.run(app.state.task_scheduler.tick())
        occurrence, = [item for item in app.state.task_store.list_tasks() if item.get('sourceRoutineId') == routine.json()['id']]
        assert occurrence['assignedWorkflowId'] == workflow['id']
        assert occurrence['status'] == 'waiting_for_human', occurrence.get('blockerReason')
        session = app.state.session_store.get_session(occurrence['linkedSessionIds'][0])
        assert not session.get('teamId')
        assert app.state.team_store.list_teams() == []


def test_project_defaults_do_not_change_other_project_work(monkeypatch):
    from issue_projects import project_for_agents
    from relay.core.workflow_selection import selected_workflow_id
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        workflow = definition(client, project, payload)
        team = create_parent(client, payload)
        assert client.put(f"/api/v1/teams/{team['id']}/workflows/{workflow['id']}/link", json={}).status_code == 200
        route = f"/api/v1/teams/{team['id']}/workflow-defaults/{project['id']}"
        response = client.put(route, json={'workflowId': workflow['id']})
        assert response.status_code == 200, response.text
        current = response.json()['team']
        assert selected_workflow_id(current, {'projectId': project['id']}) == workflow['id']
        other = project_for_agents(app.state.project_store, project['ownerUserId'],
                                   [app.state.agent_store.get_agent(aid) for aid in payload['memberAgentIds']], name='Other')
        assert selected_workflow_id(current, {'projectId': other['id']}).startswith('preset:')
        assert client.delete(f"/api/v1/workflows/{workflow['id']}").status_code == 409
        assert client.delete(route).status_code == 200
        assert client.delete(f"/api/v1/teams/{team['id']}/workflows/{workflow['id']}/link").status_code == 200
        assert client.get(f"/api/v1/workflows/{workflow['id']}").status_code == 200


def test_standalone_workflow_uses_live_project_membership(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, here, _, project, payload):
        workflow = definition(client, project, payload)
        session = client.post(f"/api/v1/workflows/{workflow['id']}/runs", json={
            'requestId': str(uuid4()), 'taskGoal': 'Check live access',
        }).json()
        app.state.project_store.update_project(project['id'], {'members': [{**member, 'enabled': False} if member['agentId'] == workflow['workflowSteps'][0]['agentId'] else member for member in project['members']]}, expected_version=project['version'])
        first = session['workflowRuns'][0]['assignments'][0]
        binding = {key: first[key] for key in ('workflowRunId', 'workflowStepId', 'workflowAttempt', 'assignmentId')}
        result = client.post(f"/api/v1/threads/{session['id']}/workflow-decisions", json={
            **binding, 'expectedRevision': 0, 'kind': 'approve',
        })
        assert result.status_code == 409, result.text
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []


def test_canonical_definitions_refuse_non_owner_sessions(monkeypatch):
    from fastapi.testclient import TestClient
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        workflow = definition(client, project, payload)
        outsider = TestClient(app)
        assert outsider.get(f"/api/v1/workflows/{workflow['id']}").status_code == 401
        outsider.headers.update({'Authorization': 'Bearer chat-test', 'x-relay-user-id': project['ownerUserId']})
        assert outsider.get(f"/api/v1/workflows/{workflow['id']}").status_code == 403
        assert outsider.post('/api/v1/workflows', json={'name': 'No'}).status_code == 403


def test_legacy_team_edits_update_the_canonical_definition(monkeypatch):
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        team = client.post('/api/v1/teams', json=payload).json()['team']
        steps = [{**step, 'name': 'Updated canonical step', 'requiresApproval': step.get('requiresApproval', False)} for step in payload['workflowSteps']]
        result = client.patch(f"/api/v1/teams/{team['id']}", json={'workflowSteps': steps})
        assert result.status_code == 200, result.text
        canonical = client.get(f"/api/v1/workflows/{team['id']}").json()['workflow']
        assert canonical['workflowSteps'] == result.json()['team']['workflowSteps'] == steps
        parent = create_parent(client, {**payload, 'name': 'Converted Team'})
        converted = client.patch(f"/api/v1/teams/{parent['id']}", json={
            'projectId': project['id'], 'workflowSteps': steps,
        })
        assert converted.status_code == 200, converted.text
        assert client.get(f"/api/v1/workflows/{parent['id']}").json()['workflow']['workflowSteps'] == steps


def test_workflow_reassignment_replaces_an_agent_and_refuses_explicit_conflict(monkeypatch):
    with workflow_world(monkeypatch) as (_, client, _, _, project, payload):
        workflow = definition(client, project, payload)
        agent_id = payload['memberAgentIds'][0]
        task = client.post('/api/v1/tasks', json={
            'title': 'Reassign work', 'projectId': project['id'], 'assignedAgentId': agent_id,
        }).json()
        path = f"/api/v1/tasks/{task['id']}"
        result = client.patch(path, json={'assignedWorkflowId': workflow['id']})
        assert result.status_code == 200, result.text
        assert result.json()['assignedWorkflowId'] == workflow['id']
        assert not result.json().get('assignedAgentId')
        assert client.patch(path, json={'assignedWorkflowId': workflow['id'], 'assignedAgentId': agent_id}).status_code == 409
        result = client.patch(path, json={'assignedAgentId': agent_id})
        assert result.status_code == 200, result.text
        assert not result.json().get('assignedWorkflowId')
        assert result.json()['assignedAgentId'] == agent_id


def test_project_default_update_preserves_a_concurrently_changed_scope(monkeypatch):
    from issue_projects import project_for_agents
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        first = definition(client, project, payload)
        other = project_for_agents(app.state.project_store, project['ownerUserId'],
                                   [app.state.agent_store.get_agent(aid) for aid in payload['memberAgentIds']], name='Other scope')
        second = definition(client, other, payload)
        team = create_parent(client, payload)
        for workflow in (first, second):
            assert client.put(f"/api/v1/teams/{team['id']}/workflows/{workflow['id']}/link", json={}).status_code == 200
        original = app.state.team_store.get_team
        stale = original(team['id'])
        assert client.put(f"/api/v1/teams/{team['id']}/workflow-defaults/{other['id']}", json={'workflowId': second['id']}).status_code == 200
        reads = []

        def stale_first_read(team_id):
            reads.append(team_id)
            return stale if len(reads) == 1 else original(team_id)

        monkeypatch.setattr(app.state.team_store, 'get_team', stale_first_read)
        response = client.put(f"/api/v1/teams/{team['id']}/workflow-defaults/{project['id']}", json={'workflowId': first['id']})
        assert response.status_code == 200, response.text
        assert response.json()['team']['projectWorkflowDefaults'] == {project['id']: first['id'], other['id']: second['id']}


def test_team_owned_workflow_runs_directly_but_not_as_project_work(monkeypatch):
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        team = create_parent(client, payload)
        response = client.post(f"/api/v1/teams/{team['id']}/workflows", json={
            'name': 'Team delivery', 'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        })
        assert response.status_code == 201, response.text
        workflow = response.json()['workflow']
        assert workflow['ownerTeamId'] == team['id']
        assert workflow['projectId'] is None
        # A direct Workflow Run may choose a Project and keeps its Team.
        started = client.post(f"/api/v1/workflows/{workflow['id']}/runs", json={
            'requestId': str(uuid4()), 'taskGoal': 'Use selected Project',
            'teamId': team['id'], 'projectId': project['id'],
        })
        assert started.status_code == 201, started.text
        assert started.json()['projectId'] == project['id']
        # A Project Task never names the Team, and a Team-owned Workflow is not
        # the Project's own: neither form assigns.
        with_team = client.post('/api/v1/tasks', json={
            'title': 'Use Team process', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'], 'assignedTeamId': team['id'],
        })
        assert with_team.status_code == 400, with_team.text
        assert 'project_team_assignment_forbidden' in with_team.text
        without_team = client.post('/api/v1/tasks', json={
            'title': 'Use Team process', 'projectId': project['id'],
            'assignedWorkflowId': workflow['id'],
        })
        assert without_team.status_code == 409, without_team.text
        assert 'team_workflow_project_mismatch' in without_team.text
        other = create_parent(client, {**payload, 'name': 'Other Team'})
        assert client.put(f"/api/v1/teams/{other['id']}/workflows/{workflow['id']}/link", json={}).status_code == 409
        assert client.get(f"/api/v1/workflows/{workflow['id']}").json()['workflow']['projectId'] is None


def test_team_workflow_default_does_not_apply_to_project_work(monkeypatch):
    from issue_projects import project_for_agents
    from automation_helpers import DAILY_TRIGGERS
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        team = create_parent(client, payload)
        workflow = client.post(f"/api/v1/teams/{team['id']}/workflows", json={
            'name': 'Reusable delivery', 'workflowSteps': [{**payload['workflowSteps'][0], 'requiresApproval': True}],
        }).json()['workflow']
        response = client.patch(f"/api/v1/teams/{team['id']}", json={'defaultWorkflowId': workflow['id']})
        assert response.status_code == 200, response.text
        other = project_for_agents(app.state.project_store, project['ownerUserId'],
                                   [app.state.agent_store.get_agent(aid) for aid in payload['memberAgentIds']], name='Second Project')
        # A Team default is a Team-conversation contract; Project work names
        # its own roster Agent or Workflow and never a Team.
        for scope in (project, other):
            result = client.post('/api/v1/tasks', json={
                'title': 'Team work', 'projectId': scope['id'], 'assignedTeamId': team['id'],
            })
            assert result.status_code == 400, result.text
            assert 'project_team_assignment_forbidden' in result.text
        routine = client.post('/api/v1/tasks', json={
            'title': 'Automated Team workflow', 'projectId': other['id'], 'assignedTeamId': team['id'],
            'assignedWorkflowId': workflow['id'], 'isRoutine': True, 'routineState': 'active', 'routineTriggers': DAILY_TRIGGERS,
        })
        assert routine.status_code == 400, routine.text
        assert client.get(f"/api/v1/workflows/{workflow['id']}").json()['workflow']['projectId'] is None
