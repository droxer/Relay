"""Imported Workflow identities survive retries, edits, and deletion."""
import pytest

from relay.core.ids import new_database_id, now_iso
from relay.persistence.engine import create_all_tables
from relay.persistence.workflow.store import DatabaseWorkflowStore


def test_legacy_import_keeps_edited_and_deleted_targets(tmp_path):
    store = DatabaseWorkflowStore(f'sqlite:///{tmp_path}/workflows.db')
    create_all_tables(store.engine)
    team_id, source_id, alternate_id = (new_database_id() for _ in range(3))
    owner = new_database_id()
    payload = {
        'name': 'Delivery', 'computerId': 'device:owner:computer',
        'workflowSteps': [{
            'id': 'build', 'name': 'Build', 'agentId': new_database_id(),
            'instructions': 'Build the change', 'acceptanceCriteria': ['Verified'],
        }],
    }
    existing = store.save_workflow(owner, payload)
    definition = {
        **payload, 'id': team_id, 'ownerUserId': owner, 'enabled': True,
        'createdAt': now_iso(), 'legacyTeamId': team_id, 'legacyWorkflowId': source_id,
    }
    imported = store.import_standalone_workflow(definition, alternate_id=alternate_id)
    assert imported['id'] == team_id
    assert imported['name'] != existing['name']
    renamed = store.save_workflow(owner, {'name': 'Migrated delivery'}, workflow_id=team_id)
    assert store.import_standalone_workflow({**definition, 'id': alternate_id}, alternate_id=alternate_id) == renamed
    assert len(store.list_workflows(owner, standalone_only=True)) == 2

    store.delete_workflow(team_id)
    with pytest.raises(ValueError, match='workflow_migrated_target_disabled'):
        store.import_standalone_workflow(definition, alternate_id=alternate_id)
    assert store.list_workflows(owner, standalone_only=True) == [existing]
    assert store.get_workflow(alternate_id) is None


def test_legacy_import_keeps_an_already_migrated_alternate_when_it_becomes_default(tmp_path):
    store = DatabaseWorkflowStore(f'sqlite:///{tmp_path}/workflows.db')
    create_all_tables(store.engine)
    team_id, alternate_id = new_database_id(), new_database_id()
    definition = {
        'id': alternate_id, 'name': 'Lead-led', 'ownerUserId': new_database_id(),
        'computerId': 'device:owner:computer', 'enabled': True, 'createdAt': now_iso(),
        'legacyTeamId': team_id, 'legacyWorkflowId': 'preset:lead_led',
    }
    first = store.import_standalone_workflow(
        {**definition, 'id': team_id, 'legacyWorkflowId': 'preset:build_review'}, alternate_id=new_database_id(),
    )
    alternate = store.import_standalone_workflow(definition, alternate_id=alternate_id)
    assert store.import_standalone_workflow({**definition, 'id': team_id}, alternate_id=alternate_id) == alternate
    assert store.get_workflow(team_id) == first
