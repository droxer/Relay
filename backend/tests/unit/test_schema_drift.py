"""The migrated schema and the declared schema must not drift apart.

Relay builds its schema two different ways: production runs Alembic against
Postgres, while SQLite tests call ``metadata.create_all``. When the two disagree,
tests exercise constraints that production does not have (or vice versa), so a
real uniqueness or concurrency bug can pass CI. That is not hypothetical — the
``(agent_id, sequence)`` uniqueness on ``agent_events`` existed in the migration
and not in the metadata.

This test migrates a scratch Postgres schema to head and diffs it against
``relay.persistence.schema.metadata``. It needs a live Postgres because the
migration chain is Postgres-only (pgcrypto, jsonb, ``USING`` casts), so it skips
when one is not reachable.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from relay.persistence.schema import metadata
from relay.persistence.session_store import DatabaseSessionStore
from relay.services.task_deletion import task_has_active_linked_session
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

BACKEND_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_ROOT.parent
DEFAULT_URL = "postgresql+psycopg://relay:relay@localhost:5432/relay"

pytestmark = pytest.mark.postgres


def _database_url() -> str:
    return os.environ.get("RELAY_TEST_DATABASE_URL") or DEFAULT_URL


def _postgres_available(url: str) -> bool:
    try:
        engine = create_engine(url)
        with engine.connect() as connection:
            connection.execute(text("select 1"))
        engine.dispose()
    except SQLAlchemyError:
        return False
    return True


@pytest.fixture
def migrated_schema(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[str, str]]:
    """Migrate to head inside a throwaway schema, then drop it."""
    base_url = _database_url()
    if not _postgres_available(base_url):
        pytest.skip(f"no Postgres reachable at {base_url}")

    schema = f"drift_{uuid.uuid4().hex[:12]}"
    admin = create_engine(base_url)
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))

    # Alembic emits unqualified DDL, so search_path decides where it lands.
    scoped_url = f"{base_url}?options=-csearch_path%3D{schema}"
    monkeypatch.setenv("RELAY_DATABASE_URL", scoped_url)
    try:
        # env.py reads RELAY_DATABASE_URL first; the url cannot go through
        # alembic.ini because configparser interpolates the '%' escapes.
        config = Config(str(REPO_ROOT / "backend" / "alembic.ini"))
        config.set_main_option("script_location", str(BACKEND_ROOT / "migrations"))
        command.upgrade(config, "head")
        yield scoped_url, schema
    finally:
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin.dispose()


def _significant(diff: Any) -> bool:
    """Drop diffs that reflect reflection limits rather than real drift."""
    kind = diff[0] if isinstance(diff, tuple) else None
    if kind in {"add_table", "remove_table"}:
        name = getattr(diff[1], "name", diff[1])
        return name != "alembic_version"
    # Server-side defaults are set by migrations for backfill purposes and
    # deliberately dropped from the declared metadata.
    return kind not in {"modify_default", "modify_comment"}


def test_migrated_schema_matches_declared_metadata(
    migrated_schema: tuple[str, str],
) -> None:
    url, schema = migrated_schema
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(
                connection,
                opts={
                    "target_metadata": metadata,
                    "compare_type": True,
                    "include_schemas": False,
                    "version_table_schema": schema,
                },
            )
            diffs = [
                diff for diff in compare_metadata(context, metadata) if _significant(diff)
            ]
    finally:
        engine.dispose()

    assert diffs == [], "schema drift:\n" + "\n".join(str(diff) for diff in diffs)


def test_dangling_legacy_session_id_is_treated_as_missing(
    migrated_schema: tuple[str, str],
) -> None:
    url, _schema = migrated_schema
    store = DatabaseSessionStore(url)

    with pytest.raises(KeyError, match="ses_legacy"):
        store.get_session("ses_legacy")

    assert not task_has_active_linked_session(
        store,
        {"linkedSessionIds": ["ses_legacy"]},
    )


def test_empty_project_migration_preserves_data_and_guards_downgrade(
    migrated_schema: tuple[str, str],
) -> None:
    from relay.persistence.agent_store import DatabaseAgentStore
    from relay.persistence.project_store import DatabaseProjectStore
    from relay.security.auth import DatabaseUserAuthStore

    url, _schema = migrated_schema
    owner = DatabaseUserAuthStore(url).create_user(
        "project-owner", "kestrel-vault-7719", employee_id="project-owner"
    )["employeeId"]
    store = DatabaseProjectStore(url)
    project = store.create_project(owner, {
        "name": "New project", "computerId": "device:review", "members": [],
    })
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "migrations"))
    with pytest.raises(RuntimeError, match="assign their lead agents first"):
        command.downgrade(config, "20260908_0066")
    assert store.get_project(project["id"]) == project

    agent = DatabaseAgentStore(url).create_agent(owner, {
        "displayName": "Lead", "executorKind": "codex", "defaultRole": "planner",
    })
    populated = store.update_project(project["id"], {
        "leadAgentId": agent["id"],
        "members": [{
            "agentId": agent["id"], "role": "planner", "functionTitle": "Lead",
            "responsibilities": "Plan",
        }],
    }, expected_version=1)
    command.downgrade(config, "20260908_0066")
    command.upgrade(config, "head")
    assert store.get_project(project["id"]) == populated
