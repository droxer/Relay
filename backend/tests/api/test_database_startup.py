from pathlib import Path

import pytest

from relay.app import create_app


@pytest.mark.parametrize("repairs_enabled", ["0", "1"])
def test_startup_uses_database_and_leaves_retired_files_untouched(
    monkeypatch, tmp_path: Path, repairs_enabled: str
) -> None:
    monkeypatch.setenv("RELAY_STARTUP_REPAIRS", repairs_enabled)
    app = create_app(tmp_path)
    account = app.state.auth_store.create_account("admin", "kestrel-vault-7719", role="admin")
    # Corrupt files must neither block startup nor replace database records.
    retired_files = [
        tmp_path / "auth/users.json",
        tmp_path / "daemon/nodes/old.json",
        tmp_path / "agents/old/snapshot.json",
        tmp_path / "managed-nodes/nodes/old.json",
        tmp_path / "profile-images/agents/old.png",
    ]
    for path in retired_files:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"retired file content")

    restarted = create_app(tmp_path)

    assert restarted.state.auth_store.authenticate("admin", "kestrel-vault-7719")["id"] == account["id"]
    assert restarted.state.managed_node_store.list_nodes() == []
    assert all(path.read_bytes() == b"retired file content" for path in retired_files)
