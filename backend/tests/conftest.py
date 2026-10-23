from __future__ import annotations

import pytest
from postgres_backend import database_url_for, postgres_backend_requested, postgres_test_databases
from relay.security import admin_token as admin_token_module


@pytest.fixture(autouse=True)
def clear_storage_env(monkeypatch, tmp_path) -> None:
    # create_app wires a module-level admin token store; never let one test's
    # database answer for the next.
    monkeypatch.setattr(admin_token_module, "_admin_token_store", None)
    monkeypatch.delenv("RELAY_STORAGE", raising=False)
    monkeypatch.delenv("RELAY_AUTH_STORE", raising=False)
    monkeypatch.delenv("RELAY_DAEMON_STORE", raising=False)
    monkeypatch.delenv("RELAY_CHAT_STORE", raising=False)
    monkeypatch.delenv("RELAY_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("RELAY_DATABASE_URL", f"sqlite:///{tmp_path}/relay-sessions.db")


@pytest.fixture(autouse=True)
def postgres_store_backend(clear_storage_env, monkeypatch, tmp_path, request):
    """Rebuild the test's databases on Postgres when RELAY_TEST_STORE_BACKEND=postgres."""
    if not postgres_backend_requested():
        yield
        return
    with postgres_test_databases(alias_text_ids=request.node.get_closest_marker("postgres") is None):
        monkeypatch.setenv(
            "RELAY_DATABASE_URL", database_url_for(f"sqlite:///{tmp_path}/relay-sessions.db"))
        yield
