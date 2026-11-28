import pytest

from relay.core.workflow_selection import (
    PREDEFINED_WORKFLOWS, default_workflow_id, selected_workflow_id, predefined_style,
)
from relay.collaboration.styles import resolve_collaboration_style
from relay.persistence.team.store import DatabaseTeamStore


def test_predefined_catalog_and_legacy_defaults():
    assert [item['id'] for item in PREDEFINED_WORKFLOWS] == [
        'preset:build_review', 'preset:lead_led',
    ]
    assert default_workflow_id({}) == 'preset:build_review'
    assert default_workflow_id({'collaborationStyle': 'pipeline'}) == 'preset:pipeline'
    assert default_workflow_id({'collaborationStyle': 'solo'}) == 'preset:build_review'
    assert predefined_style('preset:lead_led') == 'lead_led'
    assert predefined_style('custom-id') is None


def test_selection_precedence_and_legacy_aliases():
    team = {'defaultWorkflowId': 'custom'}
    assert selected_workflow_id(team) == 'custom'
    assert selected_workflow_id(team, {'assignedWorkflowId': 'preset:pipeline'}) == 'preset:pipeline'
    assert selected_workflow_id(team, {'collaborationStyle': 'lead_led'}) == 'preset:lead_led'
    assert selected_workflow_id(team, {'assignedWorkflowId': None}) == 'custom'
    assert resolve_collaboration_style({'defaultWorkflowId': 'preset:pipeline'}, None, None) == 'pipeline'
    assert resolve_collaboration_style(team, {'assignedWorkflowId': 'preset:lead_led'}, None) == 'lead_led'
    with pytest.raises(ValueError, match='workflow_requires_project_runtime'):
        resolve_collaboration_style(team, None, None)


def test_team_store_validates_and_persists_predefined_defaults(tmp_path):
    store = DatabaseTeamStore(f'sqlite:///{tmp_path}/workflow.db', create_schema=True)
    team = store.create_team('owner', {'name': 'Team', 'leadAgentId': 'lead', 'memberAgentIds': ['lead'],
                                      'defaultWorkflowId': 'preset:pipeline'})
    assert store.get_team(team['id'])['defaultWorkflowId'] == 'preset:pipeline'
    saved = store.update_team(team['id'], {'defaultWorkflowId': 'preset:lead_led'})
    assert saved['defaultWorkflowId'] == 'preset:lead_led'
    before = store.events(team['id'])
    with pytest.raises(ValueError):
        store.update_team(team['id'], {'defaultWorkflowId': 'preset:unknown'})
    assert store.events(team['id']) == before


@pytest.mark.parametrize('value', ['', None, 1, [], 'preset:missing'])
def test_invalid_workflow_ids_fail_closed(value):
    with pytest.raises(ValueError):
        predefined_style(value)


def test_run_selection_aliases_are_explicit_and_immutable():
    from relay.core.workflow_selection import requested_workflow_style
    assert requested_workflow_style(None, 'pipeline') == 'pipeline'
    assert requested_workflow_style('preset:lead_led') == 'lead_led'
    with pytest.raises(ValueError, match='conflict'):
        requested_workflow_style('preset:pipeline', 'lead_led')
    with pytest.raises(ValueError, match='requires_project'):
        requested_workflow_style('custom')
