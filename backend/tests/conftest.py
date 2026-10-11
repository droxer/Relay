from __future__ import annotations

import pytest
from relay.security import auth as auth_module


@pytest.fixture(autouse=True)
def clear_storage_env(monkeypatch, tmp_path) -> None:
    # create_app wires a module-level admin token store; never let one test's
    # database answer for the next.
    monkeypatch.setattr(auth_module, "_admin_token_store", None)
    monkeypatch.delenv("RELAY_STORAGE", raising=False)
    monkeypatch.delenv("RELAY_AUTH_STORE", raising=False)
    monkeypatch.delenv("RELAY_DAEMON_STORE", raising=False)
    monkeypatch.delenv("RELAY_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("RELAY_DATABASE_URL", f"sqlite:///{tmp_path}/relay-sessions.db")
