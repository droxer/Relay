"""Local configuration conversion preserves envelopes and fails atomically."""

import json
from datetime import UTC, datetime

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import insert, select, text, update

from relay.persistence.chat.store import DatabaseChatIntegrationStore
from relay.persistence.engine import create_all_tables, shared_engine
from relay.persistence.tables.chat import documents, integration_secrets
from store_fixtures import make_chat_store


def seed(engine, values):
    with engine.begin() as conn:
        conn.execute(
            insert(documents),
            [
                {"document_key": key, "payload": payload, "updated_at": datetime.now(UTC)}
                for key, payload in values.items()
            ],
        )


@pytest.mark.parametrize("bad", [{"object": "not an array"}, [1], [{"id": ""}], [{"id": "same"}] * 2])
def test_sqlite_configuration_conversion_retains_invalid_source(tmp_path, bad):
    url = f"sqlite:///{tmp_path}/legacy.db"
    engine = shared_engine(url)
    create_all_tables(engine)
    seed(engine, {"integrations": bad})
    with pytest.raises(ValueError, match="Legacy chat integrations"):
        DatabaseChatIntegrationStore(url, create_schema=True)
    with engine.begin() as conn:
        assert conn.scalar(select(documents.c.payload)) == bad
        assert conn.scalar(text("SELECT count(*) FROM chat_integrations")) == 0


def test_sqlite_secret_conversion_waits_for_key_and_preserves_orphans(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/legacy.db"
    engine = shared_engine(url)
    create_all_tables(engine)
    key = Fernet.generate_key()
    values = {"old": {"botToken": "credential-legacy"}, "orphan": {"extension": {"keep": True}}}
    envelope = {"ciphertext": Fernet(key).encrypt(json.dumps(values).encode()).decode()}
    seed(engine, {"integrations": [{"id": "old", "provider": "discord", "extra": "keep"}], "secrets": envelope})
    monkeypatch.delenv("RELAY_CHAT_SECRET_KEY", raising=False)
    store = DatabaseChatIntegrationStore(url, create_schema=True)
    with pytest.raises(ValueError, match="RELAY_CHAT_SECRET_KEY"):
        store.get_integration("old")
    with engine.begin() as conn:
        assert conn.scalar(select(documents.c.payload)) == envelope
        assert conn.scalar(select(integration_secrets.c.integration_id)) is None
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", key.decode())
    store = DatabaseChatIntegrationStore(url)
    assert store.get_integration("old")["extra"] == "keep"
    assert store.connection_settings("old")["secrets"] == values["old"]
    with engine.begin() as conn:
        rows = conn.execute(select(integration_secrets)).mappings().all()
        assert {
            row["integration_id"]: json.loads(Fernet(key).decrypt(row["ciphertext"].encode())) for row in rows
        } == values
        assert conn.scalar(select(documents.c.document_key).where(documents.c.document_key == "secrets")) is None
    assert "credential-legacy" not in json.dumps([dict(row) for row in rows])


def test_inactive_corrupt_credentials_do_not_break_other_integrations(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", Fernet.generate_key().decode())
    store = make_chat_store(tmp_path)
    a, b = [
        store.create_integration({"provider": "discord", "secrets": {"botToken": name}}) for name in ("valid", "bad")
    ]
    store.add_identity_link(a["id"], {"externalUserId": "external", "userId": "owner"})
    store.add_allowed_conversation(a["id"], {"conversationId": "conversation"})
    store.check_integration(a["id"], provider_health=(True, "healthy"))
    store.activate_integration(a["id"])
    with store.engine.begin() as conn:
        conn.execute(
            update(integration_secrets)
            .where(integration_secrets.c.integration_id == b["id"])
            .values(ciphertext="invalid")
        )
    assert len(store.list_integrations()) == 2
    assert store.connection_settings(a["id"])["secrets"] == {"botToken": "valid"}
    assert [record["id"] for record in store.runtime_integrations()] == [a["id"]]
    with pytest.raises(ValueError, match="cannot decrypt"):
        store.connection_settings(b["id"])
