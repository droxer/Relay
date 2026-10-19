from __future__ import annotations

import pytest
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
