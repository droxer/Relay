from __future__ import annotations

from pathlib import Path

import pytest
from relay.persistence.org.admin_tokens import DatabaseAdminTokenStore
from relay.security import admin_token as admin_token_module
from relay.security.admin_token import (
    admin_token_configured,
    configure_admin_token,
    reissue_admin_token,
    verify_admin_token,
)
from sqlalchemy import select


@pytest.fixture
def store(tmp_path: Path) -> DatabaseAdminTokenStore:
    return DatabaseAdminTokenStore(f"sqlite:///{tmp_path}/admin.db", create_schema=True)


@pytest.fixture(autouse=True)
def reset_admin_token_wiring(monkeypatch) -> None:
    monkeypatch.delenv("RELAY_ADMIN_TOKEN", raising=False)
    monkeypatch.setattr(admin_token_module, "_admin_token_store", None)


def _stored_hashes(store: DatabaseAdminTokenStore) -> list[str]:
    with store.engine.connect() as conn:
        return list(conn.scalars(select(store.tokens.c.token_hash)))


class TestStore:
    def test_starts_unconfigured(self, store) -> None:
        assert store.is_configured() is False
        assert store.verify("anything") is False

    def test_seed_stores_only_a_hash(self, store) -> None:
        assert store.seed("seeded-token") is True
        assert store.verify("seeded-token") is True
        assert store.verify("seeded-token-x") is False
        assert "seeded-token" not in _stored_hashes(store)

    def test_seed_never_overwrites_a_stored_token(self, store) -> None:
        store.seed("first")
        assert store.seed("second") is False
        assert store.verify("first") is True
        assert store.verify("second") is False

    def test_issue_rotates_and_kills_the_old_token(self, store) -> None:
        store.seed("first")
        issued = store.issue()
        assert len(issued) >= 32
        assert store.verify(issued) is True
        assert store.verify("first") is False
        assert len(_stored_hashes(store)) == 1

    def test_issue_works_with_nothing_stored(self, store) -> None:
        issued = store.issue()
        assert store.is_configured() is True
        assert store.verify(issued) is True

    def test_empty_candidate_never_verifies(self, store) -> None:
        store.seed("token")
        assert store.verify("") is False


class TestConfigure:
    def test_env_seeds_an_empty_store(self, store, tmp_path, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_ADMIN_TOKEN", "from-env")
        configure_admin_token(tmp_path, store)
        assert verify_admin_token("from-env") is True

    def test_env_does_not_replace_a_stored_token(self, store, tmp_path, monkeypatch) -> None:
        store.seed("stored")
        monkeypatch.setenv("RELAY_ADMIN_TOKEN", "from-env")
        configure_admin_token(tmp_path, store)
        assert verify_admin_token("stored") is True
        assert verify_admin_token("from-env") is False

    def test_nothing_is_generated_without_a_seed(self, store, tmp_path) -> None:
        configure_admin_token(tmp_path, store)
        assert admin_token_configured() is False
        assert not (tmp_path / "auth" / "admin-token").exists()

    def test_legacy_file_is_imported_as_a_hash_and_removed(self, store, tmp_path, monkeypatch) -> None:
        legacy = tmp_path / "auth" / "admin-token"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("legacy-token\n", encoding="utf-8")
        # The file was authoritative over the env var, so it still wins.
        monkeypatch.setenv("RELAY_ADMIN_TOKEN", "from-env")

        configure_admin_token(tmp_path, store)

        assert verify_admin_token("legacy-token") is True
        assert verify_admin_token("from-env") is False
        assert not legacy.exists()

    def test_legacy_file_is_removed_when_the_store_already_has_a_token(self, store, tmp_path) -> None:
        store.seed("stored")
        legacy = tmp_path / "auth" / "admin-token"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("stale", encoding="utf-8")

        configure_admin_token(tmp_path, store)

        assert verify_admin_token("stored") is True
        assert verify_admin_token("stale") is False
        assert not legacy.exists()

    def test_reissue_returns_a_working_token(self, store, tmp_path) -> None:
        configure_admin_token(tmp_path, store)
        token = reissue_admin_token()
        assert verify_admin_token(token) is True

    def test_unwired_module_rejects_everything(self) -> None:
        assert admin_token_configured() is False
        assert verify_admin_token("anything") is False
        with pytest.raises(ValueError):
            reissue_admin_token()
