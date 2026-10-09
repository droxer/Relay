from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, select, text

from relay.core.model_policy import normalize_model_policy, policy_model
from relay.persistence.agent_store import DatabaseAgentStore


@pytest.mark.parametrize(
    "model",
    [
        "claude-opus-5-5",
        "gpt-5.1-codex",
        "openai/gpt-5",
        "qwen3:32b",
        "claude-sonnet-5-5[1m]",
    ],
)
def test_accepts_runtime_model_ids(model: str) -> None:
    assert normalize_model_policy({"model": f"  {model} "}) == {"model": model}


@pytest.mark.parametrize("value", [{}, {"model": None}, {"model": "   "}])
def test_blank_model_means_runtime_default(value: dict) -> None:
    assert normalize_model_policy(value) == {}


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ({"model": "gpt; rm -rf /"}, "may only contain"),
        ({"model": "-m"}, "may only contain"),
        ({"model": 5}, "must be a string"),
        ({"model": "a" * 129}, "at most 128"),
        ({"model": "gpt-5", "temperature": 0}, "Unsupported modelPolicy"),
    ],
)
def test_rejects_unsafe_or_unknown_policy(value: dict, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        normalize_model_policy(value)


def test_policy_model_reads_pinned_model() -> None:
    assert policy_model({"modelPolicy": {"model": "gpt-5"}}) == "gpt-5"
    assert policy_model({"modelPolicy": {}}) is None
    assert policy_model({}) is None


def test_database_store_keeps_the_model_column_in_step_with_the_snapshot(
    tmp_path: Path,
) -> None:
    store = DatabaseAgentStore(f"sqlite:///{tmp_path}/model.db", create_schema=True)

    def model_column(agent_id: str) -> str | None:
        with store.engine.connect() as conn:
            return conn.execute(
                select(store.agents.c.model).where(store.agents.c.id == agent_id)
            ).scalar_one()

    agent = store.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
            "modelPolicy": {"model": "gpt-5.1-codex"},
        },
    )
    assert model_column(agent["id"]) == "gpt-5.1-codex"

    store.update_agent(agent["id"], {"modelPolicy": {"model": "gpt-5.1"}})
    assert model_column(agent["id"]) == "gpt-5.1"

    store.update_agent(agent["id"], {"modelPolicy": {}})
    assert model_column(agent["id"]) is None


def test_migration_backfills_the_model_column_from_snapshots(tmp_path: Path) -> None:
    migration_path = (
        Path(__file__).resolve().parents[2]
        / "migrations/versions/20261010_0084_agent_model.py"
    )
    spec = importlib.util.spec_from_file_location("agent_model_migration", migration_path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine(f"sqlite:///{tmp_path}/backfill.db")
    with engine.begin() as conn:
        conn.execute(text("create table agents (id text primary key, snapshot json)"))
        for agent_id, snapshot in [
            ("pinned", {"modelPolicy": {"model": " claude-opus-5-5 "}}),
            ("default", {"modelPolicy": {}}),
            ("legacy", {}),
        ]:
            conn.execute(
                text("insert into agents values (:id, :snapshot)"),
                {"id": agent_id, "snapshot": json.dumps(snapshot)},
            )
        with Operations.context(MigrationContext.configure(conn)):
            migration.upgrade()
        models = dict(conn.execute(text("select id, model from agents")).all())

    assert models == {"pinned": "claude-opus-5-5", "default": None, "legacy": None}
