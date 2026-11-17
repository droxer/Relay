"""The schema migration preserves legacy IDs and existing frozen Runs."""
import importlib

import pytest

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import update, inspect

from relay.persistence.engine import store_transaction
from relay.persistence.tables.teams import teams
from relay.persistence.tables.workflows import workflows, links, events
from test_team_workflows import workflow_world


def test_extracts_legacy_snapshot_once_without_rewriting_history(monkeypatch):
    migration = importlib.import_module('migrations.versions.20261117_0129_independent_workflows')
    with workflow_world(monkeypatch) as (app, client, _, _, project, payload):
        team = client.post('/api/v1/teams', json=payload).json()['team']
        old = team['workflows'][0]
        snapshot = {key: value for key, value in team.items() if key != 'workflowStorageVersion'}
        with store_transaction(app.state.team_store.engine) as conn:
            conn.execute(update(teams).where(teams.c.id == team['id']).values(snapshot=snapshot))
            for table in (events, links, workflows):
                table.drop(conn)
            with Operations.context(MigrationContext.configure(conn)):
                migration.upgrade()
                migration.upgrade()
        imported = app.state.team_store.workflow_store.get_workflow(old['id'])
        for key in ('id', 'projectId', 'workflowSteps', 'name', 'createdAt', 'updatedAt'):
            assert imported[key] == old[key]
        assert imported['projectId'] == project['id']
        assert app.state.team_store.get_team(team['id'])['workflows'][0]['id'] == old['id']


def test_empty_downgrade_roundtrips_but_stored_definitions_are_protected(monkeypatch):
    migration = importlib.import_module('migrations.versions.20261117_0129_independent_workflows')
    with workflow_world(monkeypatch) as (app, client, _, _, _, payload):
        with store_transaction(app.state.team_store.engine) as conn:
            with Operations.context(MigrationContext.configure(conn)):
                migration.downgrade()
                assert not inspect(conn).has_table('workflows')
                migration.upgrade()
        team = client.post('/api/v1/teams', json=payload).json()['team']
        with store_transaction(app.state.team_store.engine) as conn:
            with Operations.context(MigrationContext.configure(conn)):
                with pytest.raises(RuntimeError, match='forward fix'):
                    migration.downgrade()
        assert app.state.team_store.workflow_store.get_workflow(team['id'])
