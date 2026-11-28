"""Exercise the Team backfill against durable Task and daemon events."""
import asyncio

import pytest
from loguru import logger

from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.core.ids import new_database_id
from relay.migrations_runtime.standalone_workflows import LegacyWorkflowMigration

from issue_projects import project_for_agents
from test_standalone_workflows import create_definition, standalone_world
from test_team_computer import _agent, _create, _sync


def migrate(app):
    state = app.state
    return LegacyWorkflowMigration(
        state.team_store, state.task_store, state.agent_store, state.agent_placement_store, state.registry,
    ).run()


def legacy_task(app, team, **fields):
    return app.state.task_store.create_task({
        'title': 'Legacy assignment', 'ownerUserId': team['ownerUserId'], 'assignedTeamId': team['id'], **fields,
    })


def create_team(client, lead, *members, **fields):
    response = _create(client, lead, *members, **fields)
    assert response.status_code == 201, response.text
    return response.json()['team']


def command_event_fields(command):
    return {**{key: command[key] for key in ('sessionId', 'runId', 'agent', 'leaseId')}, 'commandId': command['id']}


@pytest.mark.parametrize('style', ['build_review', 'lead_led'])
def test_predefined_workflow_only_allows_name_changes(monkeypatch, style):
    with standalone_world(monkeypatch) as (app, client, _, _, lead, _):
        team = create_team(client, lead, collaborationStyle=style)
        migrate(app)
        path = f"/api/v1/workflows/{team['id']}"
        before = client.get(path).json()['workflow']
        assert before['kind'] == 'predefined'
        for patch in (
            {'enabled': False}, {'enabled': True}, {'workflowSteps': []},
            {'computerId': 'another-computer'}, {'name': 'Changed', 'enabled': False},
        ):
            rejected = client.patch(path, json=patch)
            assert rejected.status_code == 400, rejected.text
            assert client.get(path).json()['workflow'] == before

        renamed = client.patch(path, json={'name': 'Renamed preset', 'expectedVersion': before['version']})
        assert renamed.status_code == 200, renamed.text
        saved = renamed.json()['workflow']
        assert saved['name'] == 'Renamed preset'
        assert saved['version'] == before['version'] + 1
        assert saved['predefined'] == before['predefined']
        assert saved['computerId'] == before['computerId']
        assert saved['enabled'] == before['enabled']
        assert client.patch(path, json={'name': 'Stale edit', 'expectedVersion': before['version']}).status_code == 409
        assert client.patch(path, json={'name': '  '}).status_code == 400
        rejected = client.delete(path)
        assert rejected.status_code == 409, rejected.text
        assert rejected.json()['detail'] == 'workflow_predefined_immutable'
        assert client.get(path).json()['workflow'] == saved


def finish_command(registry, node, command):
    base = command_event_fields(command)
    registry.handle_event(node['id'], {
        'type': 'run.completed', **base, 'exitCode': 0, 'agentLog': 'done',
        'roundResult': {'status': 'done', 'work': {'status': 'done', 'evidence': ['Verified']}},
    }, 'token_node_here')


@pytest.mark.parametrize('entry', ['manual', 'scheduled'])
def test_migrate_default_and_explicit_custom_workflow_tasks(monkeypatch, entry):
    with standalone_world(monkeypatch) as (app, client, here, _, lead, body):
        team = create_team(client, lead)
        default = create_definition(client, {**body, 'computerId': None, 'ownerTeamId': team['id']})
        override = create_definition(client, {
            **body, 'computerId': None, 'ownerTeamId': team['id'], 'name': 'Alternate',
        })
        legacy_url = f"/api/v1/teams/{team['id']}"
        updated = client.patch(legacy_url, json={'defaultWorkflowId': default['id']})
        assert updated.status_code == 200, updated.text
        old_team = client.get(legacy_url).json()
        tasks = app.state.task_store
        inherited = legacy_task(app, team, status='assigned' if entry == 'scheduled' else 'backlog')
        selected = legacy_task(app, team, assignedWorkflowId=override['id'], collaborationStyle='lead_led')
        before = tasks.get_task(inherited['id'])
        source_definition = client.get(f"/api/v1/workflows/{default['id']}").json()
        migrate(app)
        choices = client.get('/api/v1/workflows?scope=standalone&view=choices').json()['workflows']
        assert len(choices) == 2
        assert all(option['computerId'] == computer_id(here) and option['stepAgentIds'] == [lead['id']] for option in choices)
        default_copy = client.get(f"/api/v1/workflows/{team['id']}").json()['workflow']
        assert default_copy['workflowSteps'] == default['workflowSteps']
        assert default_copy['legacyWorkflowId'] == default['id']
        assert 'ownerTeamId' not in default_copy
        assert client.get(legacy_url).json() == old_team
        assert client.get(f"/api/v1/workflows/{default['id']}").json() == source_definition

        inherited_record = tasks.get_task(inherited['id'])
        selected_record = tasks.get_task(selected['id'])
        assert inherited_record['assignedWorkflowId'] == default_copy['id']
        assert inherited_record['events'][:len(before['events'])] == before['events']
        assert sum(event['type'] == 'task.assigned' for event in inherited_record['events']) == 2
        assert selected_record['assignedWorkflowId'] == next(
            option['id'] for option in choices if option['name'] == 'Alternate'
        )
        for task in (inherited_record, selected_record):
            assert task['computerId'] == computer_id(here)
            assert 'assignedTeamId' not in task and 'collaborationStyle' not in task
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []

        migrate(app)
        assert tasks.get_task(inherited['id']) == inherited_record
        assert tasks.get_task(selected['id']) == selected_record
        assert client.get('/api/v1/workflows?scope=standalone&view=choices').json()['workflows'] == choices
        if entry == 'scheduled':
            asyncio.run(app.state.task_scheduler.tick())
            thread_id = tasks.get_task(inherited['id'])['linkedSessionIds'][0]
            session = app.state.session_store.get_session(thread_id)
        else:
            started = client.post(f"/api/v1/tasks/{inherited['id']}/runs", json={})
            assert started.status_code == 202, started.text
            session = started.json()['session']
        assert not session.get('teamId') and not session.get('projectId')
        [run] = session['workflowRuns']
        assert run['status'] == 'awaiting_approval'
        assert run['teamSnapshot']['workflowId'] == default_copy['id']
        migrate(app)
        assert app.state.session_store.get_session(session['id'])['workflowRuns'] == [run]


@pytest.mark.parametrize('entry', ['manual', 'scheduled'])
def test_predefined_migration_preserves_roles_and_frozen_active_round(monkeypatch, entry):
    with standalone_world(monkeypatch) as (app, client, here, there, lead, _):
        here = app.state.registry.register({
            **here, 'sandboxId': here['id'], 'token': 'token_node_here',
            'protocolVersion': 1, 'supportedAgents': ['codex', 'claude'],
            'capabilities': [*here['capabilities'], 'work-results'],
        })
        review = _agent(app, here, 'Reviewer')
        app.state.agent_store.update_agent(review['id'], {'defaultRole': 'reviewer'})
        _sync(app, here, there)
        team = create_team(client, lead, review, humanApproval=True, collaborationStyle='build_review')
        old = legacy_task(app, team, computerId=computer_id(here))
        pending = legacy_task(app, team, status='assigned' if entry == 'scheduled' else 'backlog',
                              collaborationStyle='lead_led')
        path = f"/api/v1/tasks/{old['id']}/runs"
        started = client.post(path, json={})
        assert started.status_code == 202, started.text
        session = started.json()['session']
        assert session['teamId'] == team['id']
        [command] = app.state.registry.take_commands(here['id'], 'token_node_here')
        assert command['logicalAgentId'] == lead['id']
        app.state.registry.handle_event(
            here['id'], {'type': 'run.executing', **command_event_fields(command)}, 'token_node_here',
        )
        assert app.state.task_store.get_task(old['id'])['status'] == 'running'
        request = app.state.registry.daemon_store.active_run_request_for_task(old['id'])
        frozen = app.state.session_store.get_session(session['id'])
        migrate(app)

        assert app.state.registry.daemon_store.active_run_request_for_task(old['id']) == request
        assert app.state.session_store.get_session(session['id']) == frozen
        assert app.state.task_store.get_task(old['id'])['assignedWorkflowId'] == team['id']
        finish_command(app.state.registry, here, command)
        current = app.state.task_store.get_task(old['id'])
        assert current['status'] == 'waiting_for_human'
        assert app.state.session_store.get_session(session['id'])['collaborationRounds'][0]['teamSnapshot'][
            'workflowId'
        ] == 'preset:build_review'
        waiting = client.get(f"/api/v1/tasks/{old['id']}").json()['awaiting']
        assert waiting['nextAgentId'] == review['id']
        approved = client.post(f"/api/v1/threads/{session['id']}/messages", json={
            'text': 'Approved', 'questionId': waiting['questionId'], 'approve': True,
        })
        assert approved.status_code == 202, approved.text
        [review_command] = app.state.registry.take_commands(here['id'], 'token_node_here')
        assert review_command['logicalAgentId'] == review['id']
        finish_command(app.state.registry, here, review_command)
        assert app.state.task_store.get_task(old['id'])['status'] in ('review', 'done')

        workflow_id = app.state.task_store.get_task(pending['id'])['assignedWorkflowId']
        choice = client.get(f'/api/v1/workflows/{workflow_id}').json()['workflow']
        assert choice['predefined']['template'] == 'lead_led'
        assert choice['legacyWorkflowId'] == 'preset:lead_led'
        assert choice['computerId'] == computer_id(here)
        assert choice['id'] != team['id']
        if entry == 'scheduled':
            asyncio.run(app.state.task_scheduler.tick())
            thread_id = app.state.task_store.get_task(pending['id'])['linkedSessionIds'][0]
            standalone = app.state.session_store.get_session(thread_id)
        else:
            result = client.post(f"/api/v1/tasks/{pending['id']}/runs", json={})
            assert result.status_code == 202, result.text
            standalone = result.json()['session']
        assert not standalone.get('teamId')
        [round_info] = standalone['collaborationRounds']
        assert round_info['teamSnapshot']['workflowId'] == workflow_id
        assert round_info['teamSnapshot']['leadAgentId'] == lead['id']
        assert {item['agentId'] for item in round_info['assignments']} == {lead['id'], review['id']}
        [command] = app.state.registry.take_commands(here['id'], 'token_node_here')
        assert command['logicalAgentId'] == lead['id']
        migrate(app)
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []


def test_broken_records_are_audited_and_remain_repairable(monkeypatch):
    with standalone_world(monkeypatch) as (app, client, here, there, lead, body):
        far = _agent(app, there, 'Far')
        deleted = _agent(app, here, 'Removed')
        _sync(app, here, there)
        teams = app.state.team_store
        owner = lead['supervisorUserId']
        split = teams.create_team(owner, {
            'name': 'Split', 'leadAgentId': lead['id'], 'memberAgentIds': [lead['id'], far['id']],
        })
        broken = create_team(client, lead, deleted, name='Broken roster')
        app.state.agent_store.delete_agent(deleted['id'])
        good = create_team(client, lead, name='Good')
        disabled = create_team(client, lead, name='Disabled')
        teams.update_team(disabled['id'], {'enabled': False})
        missing_agent = app.state.agent_store.create_agent(owner, {
            'displayName': 'Missing Computer', 'executorKind': 'codex', 'defaultRole': 'implementer',
            'computerId': f"device:{owner}:missing",
        })
        missing_computer = teams.create_team(owner, {
            'name': 'Missing Computer', 'leadAgentId': missing_agent['id'], 'memberAgentIds': [missing_agent['id']],
        })
        retired = create_team(client, lead, name='Retired')
        teams.update_team(retired['id'], {'collaborationStyle': 'pipeline'})
        disabled_source = create_definition(client, {
            **body, 'name': 'Disabled workflow', 'computerId': None, 'ownerTeamId': good['id'], 'enabled': False,
        })
        outsider = app.state.auth_store.create_account(
            'other', 'same-long-passphrase', email='other@example.com',
        )
        records = {
            'workflow_agent_computer_mismatch': legacy_task(app, split),
            'workflow_agent_unavailable': legacy_task(app, broken),
            'team_disabled': legacy_task(app, disabled),
            'workflow_computer_unavailable': legacy_task(app, missing_computer),
            'workflow_retired': legacy_task(app, retired),
            'workflow_disabled': legacy_task(app, good, assignedWorkflowId=disabled_source['id']),
            'workflow_not_standalone_team_owned': legacy_task(app, good, assignedWorkflowId=new_database_id()),
            'team_not_found': legacy_task(app, {**good, 'id': new_database_id()}),
            'workflow_computer_mismatch': legacy_task(app, good, computerId=computer_id(there)),
            'workflow_owner_required': legacy_task(
                app, good, ownerUserId=outsider['userId'], assignedWorkflowId='preset:lead_led',
            ),
        }
        tasks = app.state.task_store
        originals = {key: tasks.get_task(task['id']) for key, task in records.items()}
        messages = []
        sink = logger.add(lambda message: messages.append(message.record), filter=lambda record: "Skipped legacy" in record['message'])
        try:
            from relay.migrations_runtime.startup import repair_records_before_serving
            for _ in range(2):
                repair_records_before_serving(
                    team_store=teams, agent_store=app.state.agent_store,
                    agent_placement_store=app.state.agent_placement_store, task_store=tasks, registry=app.state.registry,
                )
        finally:
            logger.remove(sink)
        audit = [message['extra'] for message in messages]
        for reason, task in originals.items():
            assert tasks.get_task(task['id']) == task
            assert any(entry['record_id'] == task['id'] and entry['reason'] == reason for entry in audit), audit
        assert teams.get_team(broken['id'])['memberAgentIds'] == broken['memberAgentIds']
        assert [item['id'] for item in client.get('/api/v1/workflows?scope=standalone').json()['workflows']] == [good['id']]


def test_startup_retries_legacy_assignments_and_preserves_project_scope(monkeypatch, tmp_path):
    # Re-open the same database so the normal pre-serve migration runs twice.
    monkeypatch.setenv('RELAY_STARTUP_REPAIRS', '1')
    app = create_app(tmp_path)
    auth = app.state.auth_store.create_account('admin', 'kestrel-vault-7719', role='admin', email='admin@example.com')
    owner = auth['userId']
    here = app.state.registry.register({
        'sandboxId': 'legacy_startup', 'userId': owner, 'workspaceId': 'old-machine',
        'token': 'startup_token', 'workspacePath': '/workspace/legacy',
        'protocolVersion': 1, 'supportedAgents': ['codex'], 'status': 'ready',
    })
    agent = app.state.agent_store.create_agent(owner, {
        'displayName': 'Lead', 'executorKind': 'codex', 'defaultRole': 'implementer', 'computerId': computer_id(here),
    })
    _sync(app, here)
    teams = app.state.team_store
    team = teams.create_team(owner, {'name': 'Legacy', 'leadAgentId': agent['id'], 'memberAgentIds': [agent['id']]})
    project = project_for_agents(app.state.project_store, owner, [agent])
    steps = [{'id': 'build', 'name': 'Build', 'agentId': agent['id'], 'instructions': 'Build', 'acceptanceCriteria': ['Passes']}]
    definitions = app.state.context.workflow_store
    workflow = definitions.save_workflow(owner, {'name': 'Project only', 'projectId': project['id'], 'workflowSteps': steps})
    teams.link_workflow(team['id'], workflow['id'])
    teams.set_project_workflow_default(team['id'], project['id'], workflow['id'])
    project_legacy = teams.create_team(owner, {
        'name': 'Project legacy', 'leadAgentId': agent['id'], 'memberAgentIds': [agent['id']],
        'projectId': project['id'], 'workflowSteps': steps,
    })
    project_task = legacy_task(app, team, projectId=project['id'], assignedWorkflowId=workflow['id'])
    standalone = legacy_task(app, team)
    original_team = teams.get_team(team['id'])
    original_project_task = app.state.task_store.get_task(project_task['id'])
    restarted = create_app(tmp_path)
    migrated = restarted.state.task_store.get_task(standalone['id'])
    assert migrated['assignedWorkflowId'] == team['id']
    assert migrated['computerId'] == computer_id(here)
    assert restarted.state.task_store.get_task(project_task['id']) == original_project_task
    assert restarted.state.team_store.get_team(team['id']) == original_team
    assert restarted.state.team_store.get_team(project_legacy['id']) == project_legacy
    assert restarted.state.context.workflow_store.get_workflow(workflow['id']) == workflow
    assert [item['id'] for item in restarted.state.context.workflow_store.list_workflows(
        owner, standalone_only=True,
    )] == [team['id']]
    repeated = create_app(tmp_path)
    assert repeated.state.task_store.get_task(standalone['id']) == migrated
    assert repeated.state.registry.take_commands(here['id'], 'startup_token') == []


def test_claimed_task_is_migrated_only_after_dispatch_releases_it(monkeypatch):
    with standalone_world(monkeypatch) as (app, client, here, _, lead, _):
        team = create_team(client, lead)
        task = legacy_task(app, team, status='assigned', computerId=computer_id(here))
        store = app.state.task_store
        claimed = store.claim_task_for_dispatch(task['id'], 'codex')
        assert claimed
        migrate(app)
        assert store.get_task(task['id']) == claimed
        assert app.state.registry.take_commands(here['id'], 'token_node_here') == []
        store.release_dispatch_claim(task['id'], claimed['dispatchClaim']['id'])
        migrate(app)
        converted = store.get_task(task['id'])
        assert converted['assignedWorkflowId'] == team['id']
        assert converted['status'] == 'assigned'
        migrate(app)
        assert store.get_task(task['id']) == converted


def test_migrated_automation_creates_a_workflow_occurrence(monkeypatch):
    with standalone_world(monkeypatch) as (app, client, here, _, lead, _):
        team = create_team(client, lead)
        response = client.post('/api/v1/tasks', json={
            'title': 'Legacy Team automation', 'assignedTeamId': team['id'], 'computerId': computer_id(here),
            'isRoutine': True, 'routineState': 'active',
            'routineTriggers': [{'kind': 'webhook'}],
        })
        assert response.status_code == 201, response.text
        routine = response.json()
        migrate(app)
        result = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})
        assert result.status_code == 202, result.text
        assert result.json()['dispatch']['state'] == 'started', result.text
        occurrence = result.json()['task']
        assert occurrence['sourceRoutineId'] == routine['id']
        assert occurrence['assignedWorkflowId'] == team['id']
        assert occurrence['computerId'] == computer_id(here)
        assert not result.json()['session'].get('teamId')
