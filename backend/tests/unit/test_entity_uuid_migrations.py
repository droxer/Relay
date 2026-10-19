from __future__ import annotations

import importlib.util
import json
from io import StringIO
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text
from sqlalchemy.dialects import postgresql

from relay.persistence.agent.placements import DatabaseAgentPlacementStore
from relay.persistence.agent.store import DatabaseAgentStore
from relay.persistence.daemon.store import DatabaseDaemonStore
from relay.persistence.session.store import DatabaseSessionStore
from relay.persistence.task.store import DatabaseTaskStore
from relay.persistence.team.store import DatabaseTeamStore

MIGRATIONS = Path(__file__).parents[2] / "migrations" / "versions"


def _load_migration(filename: str):
    path = MIGRATIONS / filename
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_database_entities_use_primary_uuid_as_their_only_id() -> None:
    assert "public_id" not in DatabaseSessionStore.sessions.c
    assert "public_id" not in DatabaseAgentStore.agents.c
    assert "public_id" not in DatabaseDaemonStore.nodes.c
    assert "public_id" not in DatabaseDaemonStore.commands.c
    assert "public_id" not in DatabaseDaemonStore.runs.c
    assert "public_id" not in DatabaseDaemonStore.run_requests.c
    assert "public_id" not in DatabaseDaemonStore.events.c

    columns = (
        DatabaseSessionStore.sessions.c.id,
        DatabaseAgentStore.agents.c.id,
        DatabaseAgentPlacementStore.placements.c.agent_id,
        DatabaseAgentPlacementStore.placements.c.daemon_node_id,
        DatabaseDaemonStore.nodes.c.id,
        DatabaseDaemonStore.runs.c.session_id,
        DatabaseDaemonStore.runs.c.logical_agent_id,
        DatabaseDaemonStore.run_requests.c.session_id,
        DatabaseTaskStore.tasks.c.assigned_agent_id,
        DatabaseTaskStore.task_sessions.c.session_id,
        DatabaseTeamStore.teams.c.lead_agent_id,
    )

    assert {
        column.type.compile(dialect=postgresql.dialect()) for column in columns
    } == {"UUID"}


def test_uuid_backfill_migration_rewrites_relational_and_json_references() -> None:
    session_uuid = "11111111-1111-4111-8111-111111111111"
    agent_uuid = "22222222-2222-4222-8222-222222222222"
    node_uuid = "33333333-3333-4333-8333-333333333333"
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        for statement in (
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, public_id TEXT UNIQUE, snapshot JSON)",
            "CREATE TABLE agents (id TEXT PRIMARY KEY, public_id TEXT UNIQUE, compatibility_key TEXT, snapshot JSON)",
            "CREATE TABLE daemon_nodes (id TEXT PRIMARY KEY, public_id TEXT UNIQUE)",
            "CREATE TABLE task_sessions (session_public_id TEXT)",
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, assigned_agent_id TEXT, snapshot JSON)",
            "CREATE TABLE agent_placements (id TEXT PRIMARY KEY, agent_public_id TEXT, daemon_node_public_id TEXT, snapshot JSON)",
            "CREATE TABLE daemon_commands (id TEXT PRIMARY KEY, node_public_id TEXT, command JSON)",
        ):
            connection.execute(text(statement))
        connection.execute(
            text(
                "INSERT INTO sessions VALUES (:id, 'ses_legacy', :snapshot)"
            ),
            {
                "id": session_uuid,
                "snapshot": json.dumps(
                    {
                        "id": "ses_legacy",
                        "ownerAgentId": "agent_legacy",
                        "daemonNodeId": "sbx_legacy",
                    }
                ),
            },
        )
        connection.execute(
            text(
                "INSERT INTO agents VALUES "
                "(:id, 'agent_legacy', 'alice:sbx_legacy:codex', :snapshot)"
            ),
            {
                "id": agent_uuid,
                "snapshot": json.dumps(
                    {
                        "id": "agent_legacy",
                        "profileImageUrl": "/profile-images/agents/agent_legacy?v=1",
                        "compatibilityKey": "alice:sbx_legacy:codex",
                    }
                ),
            },
        )
        connection.execute(
            text("INSERT INTO daemon_nodes VALUES (:id, 'sbx_legacy')"),
            {"id": node_uuid},
        )
        connection.execute(text("INSERT INTO task_sessions VALUES ('ses_legacy')"))
        connection.execute(
            text("INSERT INTO tasks VALUES ('task', 'agent_legacy', :snapshot)"),
            {"snapshot": json.dumps({"linkedSessionIds": ["ses_legacy"]})},
        )
        connection.execute(
            text(
                "INSERT INTO agent_placements VALUES "
                "('placement', 'agent_legacy', 'sbx_legacy', :snapshot)"
            ),
            {
                "snapshot": json.dumps(
                    {"agentId": "agent_legacy", "daemonNodeId": "sbx_legacy"}
                )
            },
        )
        connection.execute(
            text("INSERT INTO daemon_commands VALUES ('command', 'sbx_legacy', :command)"),
            {"command": json.dumps({"sessionId": "ses_legacy"})},
        )

        migration = _load_migration("20260728_0039_backfill_entity_uuid_ids.py")
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        assert connection.execute(
            text("SELECT public_id FROM sessions")
        ).scalar_one() == session_uuid
        assert connection.execute(
            text("SELECT public_id FROM agents")
        ).scalar_one() == agent_uuid
        agent = connection.execute(
            text("SELECT compatibility_key, snapshot FROM agents")
        ).mappings().one()
        assert agent["compatibility_key"] == f"alice:{node_uuid}:codex"
        assert json.loads(agent["snapshot"])["profileImageUrl"] == (
            f"/profile-images/agents/{agent_uuid}?v=1"
        )
        assert connection.execute(
            text("SELECT public_id FROM daemon_nodes")
        ).scalar_one() == node_uuid
        assert connection.execute(
            text("SELECT session_public_id FROM task_sessions")
        ).scalar_one() == session_uuid
        task = connection.execute(
            text("SELECT assigned_agent_id, snapshot FROM tasks")
        ).mappings().one()
        assert task["assigned_agent_id"] == agent_uuid
        assert json.loads(task["snapshot"])["linkedSessionIds"] == [session_uuid]
        placement = connection.execute(
            text(
                "SELECT agent_public_id, daemon_node_public_id, snapshot "
                "FROM agent_placements"
            )
        ).mappings().one()
        assert placement["agent_public_id"] == agent_uuid
        assert placement["daemon_node_public_id"] == node_uuid
        assert json.loads(placement["snapshot"]) == {
            "agentId": agent_uuid,
            "daemonNodeId": node_uuid,
        }


def test_uuid_backfill_migration_prefers_longer_ids_when_replacing_json() -> None:
    node_uuid = "33333333-3333-4333-8333-333333333333"
    node2_uuid = "44444444-4444-4444-8444-444444444444"
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE daemon_nodes "
                "(id TEXT PRIMARY KEY, public_id TEXT UNIQUE)"
            )
        )
        connection.execute(
            text(
                "CREATE TABLE daemon_events "
                "(id TEXT PRIMARY KEY, node_public_id TEXT, payload JSON)"
            )
        )
        connection.execute(
            text("INSERT INTO daemon_nodes VALUES (:id, 'sbx')"),
            {"id": node_uuid},
        )
        connection.execute(
            text("INSERT INTO daemon_nodes VALUES (:id, 'sbx2')"),
            {"id": node2_uuid},
        )
        connection.execute(
            text("INSERT INTO daemon_events VALUES ('e', 'sbx2', :payload)"),
            {"payload": json.dumps({"node": "sbx2", "other": "sbx"})},
        )

        migration = _load_migration("20260728_0039_backfill_entity_uuid_ids.py")
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        event = connection.execute(
            text("SELECT node_public_id, payload FROM daemon_events")
        ).mappings().one()
        assert event["node_public_id"] == node2_uuid
        assert json.loads(event["payload"]) == {
            "node": node2_uuid,
            "other": node_uuid,
        }
        assert connection.execute(
            text("SELECT public_id FROM daemon_nodes WHERE id = :id"),
            {"id": node_uuid},
        ).scalar_one() == node_uuid
        assert connection.execute(
            text("SELECT public_id FROM daemon_nodes WHERE id = :id"),
            {"id": node2_uuid},
        ).scalar_one() == node2_uuid


def test_uuid_schema_migration_nulls_invalid_values_in_nullable_columns() -> None:
    agent_uuid = "22222222-2222-4222-8222-222222222222"
    migration = _load_migration("20260728_0040_use_uuid_entity_id_columns.py")
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE tasks (id TEXT PRIMARY KEY, assigned_agent_id TEXT)")
        )
        connection.execute(text("INSERT INTO tasks VALUES ('t1', 'agent_legacy')"))
        connection.execute(
            text("INSERT INTO tasks VALUES ('t2', :agent_id)"),
            {"agent_id": agent_uuid},
        )

        migration._prepare_values(connection)

        assert connection.execute(
            text("SELECT assigned_agent_id FROM tasks WHERE id = 't1'")
        ).scalar_one() is None
        assert connection.execute(
            text("SELECT assigned_agent_id FROM tasks WHERE id = 't2'")
        ).scalar_one() == agent_uuid


def test_uuid_schema_migration_rejects_invalid_values_in_required_columns() -> None:
    migration = _load_migration("20260728_0040_use_uuid_entity_id_columns.py")
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(
            text("CREATE TABLE sessions (id TEXT PRIMARY KEY, public_id TEXT)")
        )
        connection.execute(text("INSERT INTO sessions VALUES ('s', 'ses_legacy')"))

        with pytest.raises(RuntimeError, match=r"sessions\.public_id"):
            migration._prepare_values(connection)


def test_uuid_schema_migration_converts_entity_reference_columns() -> None:
    migration = _load_migration("20260728_0040_use_uuid_entity_id_columns.py")
    output = StringIO()
    context = MigrationContext.configure(
        dialect_name="postgresql",
        opts={"as_sql": True, "output_buffer": output},
    )
    migration.op = Operations(context)

    migration.upgrade()

    sql = output.getvalue()
    assert "ALTER TABLE sessions ALTER COLUMN public_id TYPE UUID" in sql
    assert "ALTER TABLE agents ALTER COLUMN public_id TYPE UUID" in sql
    assert "ALTER TABLE daemon_nodes ALTER COLUMN public_id TYPE UUID" in sql
    assert "ALTER TABLE daemon_runs ALTER COLUMN logical_agent_id TYPE UUID" in sql
    assert "ALTER TABLE task_sessions ALTER COLUMN session_public_id TYPE UUID" in sql


def test_legacy_id_contract_migration_runs_on_sqlite() -> None:
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        for statement in (
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, public_id TEXT UNIQUE)",
            "CREATE TABLE agents (id TEXT PRIMARY KEY, public_id TEXT UNIQUE)",
            "CREATE TABLE daemon_nodes (id TEXT PRIMARY KEY, public_id TEXT UNIQUE)",
            (
                "CREATE TABLE task_sessions ("
                "task_id TEXT, session_public_id TEXT, "
                "CONSTRAINT uq_task_sessions_task_session_public "
                "UNIQUE (task_id, session_public_id))"
            ),
            (
                "CREATE TABLE agent_placements ("
                "id TEXT PRIMARY KEY, agent_public_id TEXT, "
                "daemon_node_public_id TEXT)"
            ),
            (
                "CREATE INDEX ix_agent_placements_agent_public_id "
                "ON agent_placements (agent_public_id)"
            ),
            (
                "CREATE INDEX ix_agent_placements_daemon_node_public_id "
                "ON agent_placements (daemon_node_public_id)"
            ),
            (
                "CREATE TABLE daemon_runs ("
                "id TEXT PRIMARY KEY, session_public_id TEXT, "
                "node_public_id TEXT)"
            ),
            (
                "CREATE INDEX ix_daemon_runs_session_public_id "
                "ON daemon_runs (session_public_id)"
            ),
            (
                "CREATE TABLE daemon_run_requests ("
                "id TEXT PRIMARY KEY, session_public_id TEXT, "
                "node_public_id TEXT)"
            ),
            (
                "CREATE INDEX ix_daemon_run_requests_session_public_id "
                "ON daemon_run_requests (session_public_id)"
            ),
            (
                "CREATE TABLE session_run_token_usage "
                "(id TEXT PRIMARY KEY, session_public_id TEXT)"
            ),
            "CREATE TABLE daemon_commands (id TEXT PRIMARY KEY, node_public_id TEXT)",
            "CREATE TABLE daemon_events (id TEXT PRIMARY KEY, node_public_id TEXT)",
        ):
            connection.execute(text(statement))

        migration = _load_migration("20260729_0041_remove_legacy_entity_ids.py")
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        inspector = sa.inspect(connection)
        table_columns = {
            table: {column["name"] for column in inspector.get_columns(table)}
            for table in inspector.get_table_names()
        }
        assert "public_id" not in table_columns["sessions"]
        assert "public_id" not in table_columns["agents"]
        assert "public_id" not in table_columns["daemon_nodes"]
        assert "session_id" in table_columns["task_sessions"]
        assert "session_public_id" not in table_columns["task_sessions"]
        assert table_columns["agent_placements"] == {
            "id",
            "agent_id",
            "daemon_node_id",
        }
        assert "node_public_id" not in table_columns["daemon_commands"]
        assert "node_public_id" not in table_columns["daemon_events"]
        assert {
            index["name"] for index in inspector.get_indexes("agent_placements")
        } == {
            "ix_agent_placements_agent_id",
            "ix_agent_placements_daemon_node_id",
        }
        assert {
            index["name"] for index in inspector.get_indexes("daemon_runs")
        } == {"ix_daemon_runs_session_id"}


def test_remaining_public_id_migration_rewrites_and_drops_legacy_ids() -> None:
    employee_uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    employee2_uuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    department_uuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    task_uuid = "11111111-1111-4111-8111-111111111111"
    team_uuid = "55555555-5555-4555-8555-555555555555"
    agent_uuid = "22222222-2222-4222-8222-222222222222"
    command_uuid = "33333333-3333-4333-8333-333333333333"
    request_uuid = "44444444-4444-4444-8444-444444444444"
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as connection:
        for statement in (
            "CREATE TABLE departments (id TEXT PRIMARY KEY, public_id TEXT, parent_department_public_id TEXT)",
            "CREATE TABLE employees (id TEXT PRIMARY KEY, public_id TEXT, department_public_id TEXT)",
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, owner_employee_id TEXT, snapshot JSON)",
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, public_id TEXT, owner_employee_id TEXT, assignee_employee_id TEXT, snapshot JSON)",
            "CREATE TABLE task_events (id TEXT PRIMARY KEY, public_id TEXT, payload JSON)",
            "CREATE TABLE teams (id TEXT PRIMARY KEY, public_id TEXT, owner_employee_public_id TEXT, member_agent_ids JSON, snapshot JSON)",
            "CREATE TABLE team_events (id TEXT PRIMARY KEY, public_id TEXT, payload JSON)",
            "CREATE TABLE agents (id TEXT PRIMARY KEY, supervisor_employee_public_id TEXT, compatibility_key TEXT, snapshot JSON)",
            "CREATE TABLE agent_events (id TEXT PRIMARY KEY, public_id TEXT, payload JSON)",
            "CREATE TABLE agent_placements (id TEXT PRIMARY KEY, public_id TEXT, supervisor_employee_public_id TEXT, snapshot JSON)",
            "CREATE TABLE agent_placement_events (id TEXT PRIMARY KEY, public_id TEXT, payload JSON)",
            "CREATE TABLE daemon_nodes (id TEXT PRIMARY KEY, employee_id TEXT)",
            "CREATE TABLE daemon_commands (id TEXT PRIMARY KEY, public_id TEXT, command JSON)",
            "CREATE TABLE daemon_runs (id TEXT PRIMARY KEY, public_id TEXT, command_public_id TEXT)",
            "CREATE TABLE daemon_run_requests (id TEXT PRIMARY KEY, public_id TEXT, task_public_id TEXT, current_command_public_id TEXT, current_run_public_id TEXT, assignments JSON, state JSON)",
            "CREATE TABLE daemon_events (id TEXT PRIMARY KEY, public_id TEXT, command_public_id TEXT, run_public_id TEXT, payload JSON)",
            "CREATE TABLE auth_users (id TEXT PRIMARY KEY, public_id TEXT, employee_public_id TEXT)",
            "CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, public_id TEXT, user_public_id TEXT)",
            "CREATE TABLE session_events (id TEXT PRIMARY KEY, public_id TEXT, payload JSON)",
            "CREATE TABLE session_artifacts (id TEXT PRIMARY KEY, public_id TEXT, metadata JSON)",
            "CREATE TABLE session_token_usage (id TEXT PRIMARY KEY, session_id TEXT, session_public_id TEXT, owner_employee_id TEXT)",
            "CREATE TABLE session_run_token_usage (id TEXT PRIMARY KEY, owner_employee_id TEXT)",
            "CREATE TABLE chat_documents (id TEXT PRIMARY KEY, payload JSON)",
        ):
            connection.execute(text(statement))
        connection.execute(
            text("INSERT INTO departments VALUES (:id, 'eng', NULL)"),
            {"id": department_uuid},
        )
        connection.execute(
            text("INSERT INTO employees VALUES (:id, 'alice', 'eng')"),
            {"id": employee_uuid},
        )
        connection.execute(
            text("INSERT INTO employees VALUES (:id, 'Clark', NULL)"),
            {"id": employee2_uuid},
        )
        connection.execute(
            text("INSERT INTO sessions VALUES ('ses', 'alice', :snapshot)"),
            {"snapshot": json.dumps({"ownerEmployeeId": "alice"})},
        )
        connection.execute(
            text(
                "INSERT INTO tasks VALUES "
                "(:id, 'task_mrxdemi7_mg70va', 'alice', 'Clark', :snapshot)"
            ),
            {
                "id": task_uuid,
                "snapshot": json.dumps(
                    {
                        "id": "task_mrxdemi7_mg70va",
                        "ownerEmployeeId": "alice",
                        "note": "ping alice please",
                    }
                ),
            },
        )
        connection.execute(
            text(
                "INSERT INTO teams VALUES "
                "(:id, 'team_mrw9fvau_umxm0g', 'Clark', :members, :snapshot)"
            ),
            {
                "id": team_uuid,
                "members": json.dumps(["agent-1"]),
                "snapshot": json.dumps({"ownerEmployeeId": "Clark"}),
            },
        )
        connection.execute(
            text(
                "INSERT INTO agents VALUES "
                "(:id, 'alice', 'alice:node-1:codex', :snapshot)"
            ),
            {
                "id": agent_uuid,
                "snapshot": json.dumps(
                    {
                        "supervisorEmployeeId": "alice",
                        "compatibilityKey": "alice:node-1:codex",
                    }
                ),
            },
        )
        connection.execute(
            text("INSERT INTO daemon_nodes VALUES ('node', 'alice')")
        )
        connection.execute(
            text(
                "INSERT INTO daemon_commands VALUES (:id, 'cmd_live_12345', :command)"
            ),
            {"id": command_uuid, "command": json.dumps({"type": "run.start"})},
        )
        connection.execute(
            text(
                "INSERT INTO daemon_run_requests VALUES "
                "(:id, 'drun_abc_def', 'task_mrxdemi7_mg70va', "
                "'cmd_gone_99999', NULL, :assignments, :state)"
            ),
            {
                "id": request_uuid,
                "assignments": json.dumps([{"employeeId": "Clark"}]),
                "state": json.dumps(
                    {"taskId": "task_mrxdemi7_mg70va", "employeeId": "alice"}
                ),
            },
        )
        connection.execute(
            text(
                "INSERT INTO chat_documents VALUES ('doc', :payload)"
            ),
            {"payload": json.dumps({"text": "alice: hello", "employeeId": "alice"})},
        )

        migration = _load_migration("20260729_0042_remove_remaining_public_ids.py")
        migration.op = Operations(MigrationContext.configure(connection))
        migration.upgrade()

        inspector = sa.inspect(connection)
        table_columns = {
            table: {column["name"] for column in inspector.get_columns(table)}
            for table in inspector.get_table_names()
        }
        for table in (
            "tasks",
            "teams",
            "employees",
            "departments",
            "agent_placements",
            "daemon_commands",
            "daemon_runs",
            "daemon_run_requests",
            "daemon_events",
            "auth_users",
            "auth_sessions",
            "session_events",
            "task_events",
            "agent_events",
            "agent_placement_events",
            "team_events",
            "session_artifacts",
        ):
            assert "public_id" not in table_columns[table], table
        assert "supervisor_employee_id" in table_columns["agents"]
        assert "supervisor_employee_public_id" not in table_columns["agents"]
        assert "owner_employee_id" in table_columns["teams"]
        assert "owner_employee_public_id" not in table_columns["teams"]
        assert {"task_id", "current_command_id", "current_run_id"} <= table_columns[
            "daemon_run_requests"
        ]
        assert "department_public_id" not in table_columns["employees"]
        assert "parent_department_public_id" not in table_columns["departments"]
        assert "session_public_id" not in table_columns["session_token_usage"]

        assert connection.execute(
            text("SELECT supervisor_employee_id FROM agents")
        ).scalar_one() == employee_uuid
        assert connection.execute(
            text("SELECT compatibility_key FROM agents")
        ).scalar_one() == f"{employee_uuid}:node-1:codex"
        agent_snapshot = json.loads(
            connection.execute(text("SELECT snapshot FROM agents")).scalar_one()
        )
        assert agent_snapshot == {
            "supervisorEmployeeId": employee_uuid,
            "compatibilityKey": f"{employee_uuid}:node-1:codex",
        }
        assert connection.execute(
            text("SELECT owner_employee_id FROM teams")
        ).scalar_one() == employee2_uuid
        assert connection.execute(
            text("SELECT owner_employee_id FROM sessions")
        ).scalar_one() == employee_uuid
        assert connection.execute(
            text("SELECT employee_id FROM daemon_nodes")
        ).scalar_one() == employee_uuid
        task = connection.execute(
            text("SELECT owner_employee_id, assignee_employee_id, snapshot FROM tasks")
        ).mappings().one()
        assert task["owner_employee_id"] == employee_uuid
        assert task["assignee_employee_id"] == employee2_uuid
        assert json.loads(task["snapshot"]) == {
            "id": task_uuid,
            "ownerEmployeeId": employee_uuid,
            "note": "ping alice please",
        }
        request = connection.execute(
            text(
                "SELECT task_id, current_command_id, assignments, state "
                "FROM daemon_run_requests"
            )
        ).mappings().one()
        assert request["task_id"] == task_uuid
        assert request["current_command_id"] is None
        assert json.loads(request["assignments"]) == [
            {"employeeId": employee2_uuid}
        ]
        assert json.loads(request["state"]) == {
            "taskId": task_uuid,
            "employeeId": employee_uuid,
        }
        chat = json.loads(
            connection.execute(
                text("SELECT payload FROM chat_documents")
            ).scalar_one()
        )
        assert chat == {"text": "alice: hello", "employeeId": employee_uuid}


def test_legacy_id_contract_migration_drops_public_ids_and_renames_references() -> None:
    migration = _load_migration("20260729_0041_remove_legacy_entity_ids.py")
    output = StringIO()
    context = MigrationContext.configure(
        dialect_name="postgresql",
        opts={"as_sql": True, "output_buffer": output},
    )
    migration.op = Operations(context)

    migration.upgrade()

    sql = output.getvalue()
    assert "ALTER TABLE sessions DROP COLUMN public_id" in sql
    assert "ALTER TABLE agents DROP COLUMN public_id" in sql
    assert "ALTER TABLE daemon_nodes DROP COLUMN public_id" in sql
    assert (
        "ALTER TABLE task_sessions RENAME session_public_id TO session_id" in sql
    )
    assert "ALTER TABLE daemon_commands DROP COLUMN node_public_id" in sql
