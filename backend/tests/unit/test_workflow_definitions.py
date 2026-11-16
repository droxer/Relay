from copy import deepcopy

import pytest

from relay.core.workflows import team_workflows, workflow_definition, workflow_execution_snapshot
from relay.persistence.team.store import DatabaseTeamStore
from test_team_workflow_store import workflow_payload


def parent():
    return {'id': 'team', 'leadAgentId': 'lead', 'memberAgentIds': ['lead', 'builder'],
            'ownerUserId': 'owner', 'collaborationStyle': 'lead_led', 'humanApproval': True}


def definition():
    payload = workflow_payload()
    return {key: payload[key] for key in ('name', 'projectId', 'workflowSteps')}


def test_definition_identity_is_independent_and_snapshot_is_detached():
    team = parent()
    original = deepcopy(team)
    first = workflow_definition(team, definition())
    second = workflow_definition(team, {**definition(), 'name': 'Fix'})
    assert first['id'] != second['id']
    assert first['teamId'] == team['id']
    team['workflows'] = [first, second]
    snapshot = workflow_execution_snapshot(team, first['id'])
    assert snapshot['id'] == team['id']
    assert snapshot['workflowId'] == first['id']
    assert 'collaborationStyle' not in snapshot and 'humanApproval' not in snapshot
    snapshot['workflowSteps'].clear()
    assert team['workflows'][0]['workflowSteps']
    assert {key: team[key] for key in original} == original


@pytest.mark.parametrize('patch', [
    {'teamId': 'other'}, {'name': ''}, {'name': 1}, {'name': 'x' * 201},
    {'enabled': 0}, {'workflowSteps': []}, {'projectId': None},
])
def test_invalid_definition(patch):
    with pytest.raises(ValueError):
        workflow_definition(parent(), {**definition(), **patch})


def test_identity_and_project_are_immutable_on_edit():
    team = parent()
    saved = workflow_definition(team, definition())
    updated = workflow_definition(team, {'name': 'Delivery'}, current=saved)
    assert updated['id'] == saved['id']
    assert updated['createdAt'] == saved['createdAt']
    with pytest.raises(ValueError, match='immutable'):
        workflow_definition(team, {'projectId': 'other'}, current=saved)


def test_execution_fails_for_missing_disabled_or_removed_member():
    team = parent()
    saved = workflow_definition(team, definition())
    team['workflows'] = [saved]
    with pytest.raises(ValueError, match='not_found'):
        workflow_execution_snapshot(team, 'absent')
    saved['enabled'] = False
    with pytest.raises(ValueError, match='disabled'):
        workflow_execution_snapshot(team, saved['id'])
    saved['enabled'] = True
    team['memberAgentIds'] = ['lead']
    with pytest.raises(ValueError, match='not_member'):
        workflow_execution_snapshot(team, saved['id'])


def test_legacy_definition_is_exposed_without_rewriting_history():
    legacy = {**parent(), **workflow_payload(), 'createdAt': 'then', 'updatedAt': 'now'}
    before = deepcopy(legacy)
    workflows = team_workflows(legacy)
    assert workflows[0]['teamId'] == legacy['id']
    workflows[0]['workflowSteps'].clear()
    assert legacy == before
    assert team_workflows(parent()) == []
    assert team_workflows({**legacy, 'workflows': []}) == []


def test_store_atomic_events_duplicate_names_and_missing_definitions(tmp_path):
    url = f'sqlite:///{tmp_path}/teams.db'
    store = DatabaseTeamStore(url, create_schema=True)
    team = store.create_team('owner', {key: value for key, value in parent().items() if key != 'id'} | {'name': 'Crew'})
    saved = store.save_workflow(team['id'], definition())
    assert DatabaseTeamStore(url).get_team(team['id'])['workflows'] == [saved]
    events = store.events(team['id'])
    with pytest.raises(ValueError, match='name_taken'):
        store.save_workflow(team['id'], {**definition(), 'name': saved['name'].upper()})
    with pytest.raises(KeyError):
        store.save_workflow(team['id'], {'name': 'Changed'}, workflow_id='missing')
    with pytest.raises(KeyError):
        store.delete_workflow(team['id'], 'missing')
    assert store.events(team['id']) == events
    store.delete_workflow(team['id'], saved['id'])
    assert store.get_team(team['id'])['workflows'] == []
    assert store.events(team['id'])[-1]['type'] == 'team.workflow_deleted'
