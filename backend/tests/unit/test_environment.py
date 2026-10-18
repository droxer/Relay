from __future__ import annotations

from relay.core import environment


def test_load_backend_env_reads_backend_root_env(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(environment, "BACKEND_ROOT", tmp_path)
    monkeypatch.delenv("RELAY_BACKGROUND_MODE", raising=False)
    monkeypatch.delenv("RELAY_DATABASE_URL", raising=False)
    (tmp_path / ".env").write_text(
        "RELAY_BACKGROUND_MODE=external\n"
        "RELAY_DATABASE_URL=sqlite:///relay.db\n",
        encoding="utf-8",
    )

    environment.load_backend_env()

    assert environment.os.environ["RELAY_BACKGROUND_MODE"] == "external"
    assert environment.os.environ["RELAY_DATABASE_URL"] == "sqlite:///relay.db"
