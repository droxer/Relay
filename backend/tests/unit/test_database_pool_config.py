from __future__ import annotations

import pytest

from relay.persistence.store_common import database_engine_options


def test_postgres_pool_options_are_deployment_tunable(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_DB_POOL_SIZE", "24")
    monkeypatch.setenv("RELAY_DB_MAX_OVERFLOW", "12")
    monkeypatch.setenv("RELAY_DB_POOL_TIMEOUT_SECONDS", "3")
    monkeypatch.setenv("RELAY_DB_POOL_RECYCLE_SECONDS", "240")
    monkeypatch.setenv("RELAY_DB_POOL_PRE_PING", "false")

    assert database_engine_options("postgresql+psycopg://relay:test@db/relay") == {
        "pool_size": 24,
        "max_overflow": 12,
        "pool_timeout": 3.0,
        "pool_recycle": 240,
        "pool_pre_ping": False,
        "pool_use_lifo": True,
        "connect_args": {
            "options": "-c statement_timeout=30000"
            " -c idle_in_transaction_session_timeout=60000"
        },
    }


def test_sqlite_does_not_receive_server_pool_options(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_DB_POOL_SIZE", "24")

    assert database_engine_options("sqlite:///relay.db") == {}


def test_postgres_session_timeouts_are_tunable_and_disableable(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_DB_STATEMENT_TIMEOUT_MS", "5000")
    monkeypatch.setenv("RELAY_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", "0")

    options = database_engine_options("postgresql+psycopg://relay:test@db/relay")

    assert options["connect_args"] == {"options": "-c statement_timeout=5000"}


def test_postgres_timeouts_keep_options_already_in_the_url(monkeypatch) -> None:
    options = database_engine_options(
        "postgresql+psycopg://relay:test@db/relay?options=-csearch_path%3Ddrift"
    )

    assert options["connect_args"]["options"].startswith("-csearch_path=drift -c ")


def test_postgres_timeouts_reject_negative_values(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_DB_STATEMENT_TIMEOUT_MS", "-1")

    with pytest.raises(ValueError, match="RELAY_DB_STATEMENT_TIMEOUT_MS"):
        database_engine_options("postgresql+psycopg://relay:test@db/relay")
