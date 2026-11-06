"""Configuration normalization retains encrypted legacy data and rollback."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, delete, insert, inspect, select, text

from relay.persistence.chat.store import DatabaseChatIntegrationStore
from relay.persistence.tables.chat import documents
from test_schema_drift import migrated_schema as _migrated_schema

migrated_schema = _migrated_schema
pytestmark = pytest.mark.postgres
PREVIOUS = "20261106_0116"


def config():
    root = Path(__file__).resolve().parents[2]
    value = Config(str(root / "alembic.ini"))
    value.set_main_option("script_location", str(root / "migrations"))
    return value


def seed(engine, records, envelope):
    with engine.begin() as conn:
        conn.execute(delete(documents).where(documents.c.document_key.in_(("integrations", "secrets"))))
        conn.execute(
            insert(documents),
            [
                {"document_key": key, "payload": payload, "updated_at": datetime.now(UTC)}
                for key, payload in [("integrations", records), ("secrets", envelope)]
            ],
        )


def test_configuration_upgrade_and_encrypted_downgrade_preserve_new_writes(migrated_schema, monkeypatch):
    url, _ = migrated_schema
    engine = create_engine(url)
    key = Fernet.generate_key()
    cipher = Fernet(key)
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", key.decode())
    records = [{"id": "chat-old", "provider": "discord", "displayName": "before", "extension": {"preserve": True}}]
    secrets = {"chat-old": {"botToken": "legacy-token"}, "orphan-id": {"custom": {"nested": "preserve"}}}
    envelope = {"ciphertext": cipher.encrypt(json.dumps(secrets).encode()).decode()}
    try:
        command.downgrade(config(), PREVIOUS)
        seed(engine, records, envelope)
        command.upgrade(config(), "head")
        assert {"chat_integrations", "chat_integration_secrets"} <= set(inspect(engine).get_table_names())
        # Schema upgrade itself never decrypts or rewrites the legacy envelope.
        with engine.begin() as conn:
            assert conn.scalar(select(documents.c.payload).where(documents.c.document_key == "secrets")) == envelope
        store = DatabaseChatIntegrationStore(url)
        assert store.get_integration("chat-old")["extension"] == {"preserve": True}
        assert store.connection_settings("chat-old")["secrets"] == secrets["chat-old"]
        store.update_integration("chat-old", {"secrets": {"signingSecret": "new-secret"}})
        created = store.create_integration({"provider": "discord"})
        with engine.begin() as conn:
            assert conn.scalar(select(documents.c.document_key).where(documents.c.document_key == "secrets")) is None
        command.downgrade(config(), PREVIOUS)
        with engine.begin() as conn:
            restored = dict(conn.execute(select(documents.c.document_key, documents.c.payload)).all())
        assert [record["id"] for record in restored["integrations"]] == ["chat-old", created["id"]]
        assert restored["integrations"][0]["extension"] == {"preserve": True}
        decoded = json.loads(cipher.decrypt(restored["secrets"]["ciphertext"].encode()))
        assert decoded == {**secrets, "chat-old": {**secrets["chat-old"], "signingSecret": "new-secret"}}
        assert "legacy-token" not in json.dumps(restored)
        command.upgrade(config(), "head")
        assert store.connection_settings("chat-old")["secrets"]["signingSecret"] == "new-secret"
    finally:
        engine.dispose()


def test_legacy_secret_conversion_and_downgrade_fail_atomically_without_key(migrated_schema, monkeypatch):
    url, _ = migrated_schema
    engine = create_engine(url)
    key = Fernet.generate_key()
    envelope = {"ciphertext": Fernet(key).encrypt(b'{"chat-old":{"botToken":"test-token"}}').decode()}
    try:
        command.downgrade(config(), PREVIOUS)
        seed(engine, [{"id": "chat-old", "provider": "discord"}], envelope)
        monkeypatch.delenv("RELAY_CHAT_SECRET_KEY", raising=False)
        command.upgrade(config(), "head")
        assert "chat_integration_secrets" in inspect(engine).get_table_names()
        with pytest.raises(ValueError, match="RELAY_CHAT_SECRET_KEY"):
            DatabaseChatIntegrationStore(url).get_integration("chat-old")
        with engine.begin() as conn:
            assert conn.scalar(text("SELECT count(*) FROM chat_integration_secrets")) == 0
            assert conn.scalar(select(documents.c.payload).where(documents.c.document_key == "secrets")) == envelope
        monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", key.decode())
        DatabaseChatIntegrationStore(url).get_integration("chat-old")
        monkeypatch.delenv("RELAY_CHAT_SECRET_KEY", raising=False)
        with pytest.raises(RuntimeError, match="RELAY_CHAT_SECRET_KEY"):
            command.downgrade(config(), PREVIOUS)
        assert "chat_integration_secrets" in inspect(engine).get_table_names()
        with engine.begin() as conn:
            assert conn.scalar(text("SELECT count(*) FROM chat_integration_secrets")) == 1
        monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", key.decode())
        command.downgrade(config(), PREVIOUS)
    finally:
        engine.dispose()
