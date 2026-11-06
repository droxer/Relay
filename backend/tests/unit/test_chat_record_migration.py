"""Legacy chat arrays migrate losslessly and round-trip through new writes."""

import hashlib
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, delete, insert, inspect, select, text
from sqlalchemy.exc import DBAPIError

from relay.chat.integrations import DatabaseChatIntegrationStore
from relay.persistence.tables.chat import documents
from test_schema_drift import migrated_schema as _migrated_schema

# Reuse the same scratch-schema fixture without importing a name shadowed by test parameters.
migrated_schema = _migrated_schema

pytestmark = pytest.mark.postgres
OLD_REVISION = "20261106_0115"


def config():
    root = Path(__file__).resolve().parents[2]
    value = Config(str(root / "alembic.ini"))
    value.set_main_option("script_location", str(root / "migrations"))
    return value


def put_documents(engine, values):
    with engine.begin() as conn:
        conn.execute(delete(documents).where(documents.c.document_key.in_(values)))
        conn.execute(
            insert(documents),
            [
                {"document_key": key, "payload": payload, "updated_at": datetime.now(UTC)}
                for key, payload in values.items()
            ],
        )


def test_chat_records_migration_preserves_order_extensions_and_downgrade(migrated_schema, monkeypatch):
    url, _ = migrated_schema
    engine = create_engine(url)
    key = Fernet.generate_key()
    cipher = Fernet(key)
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", key.decode())
    encrypted = {"ciphertext": cipher.encrypt(b"{}").decode()}
    history = [
        {"id": "same-id", "integrationId": owner, "timestamp": timestamp, "extension": index}
        for index, (owner, timestamp) in enumerate([("a", "later"), ("b", "same"), ("a", "earlier"), ("a", "same")])
    ]
    channel = "".join(hashlib.sha256(str(i).encode()).hexdigest() for i in range(128)) + "é"
    binding = {
        "key": f"discord::org::{channel}::thread",
        "provider": "discord",
        "tenantId": "org",
        "conversationId": channel,
        "threadId": "thread",
        "sessionId": "old-thread",
        "ownerUserId": "owner",
        "extra": "keep",
    }
    try:
        command.downgrade(config(), OLD_REVISION)
        put_documents(
            engine,
            {
                "audit": history,
                "conversations": [binding],
                "secrets": encrypted,
                "integrations": [{"id": "a", "provider": "discord", "displayName": "before"}],
            },
        )
        command.upgrade(config(), "head")
        assert {"chat_audit_events", "chat_conversations"} <= set(inspect(engine).get_table_names())
        store = DatabaseChatIntegrationStore(url)
        assert store.audit_events("a", limit=2) == history[-2:]
        assert store.get_conversation_session(binding) == binding
        store.update_integration("a", {"displayName": "after"}, actor="operator")
        all_history = store.audit_events()
        assert all_history[:4] == history
        assert len(all_history) == 5, "the sequence advances after importing explicit ordinals"
        assert all_history[-1]["type"] == "chat.integration.updated"
        command.downgrade(config(), OLD_REVISION)
        with engine.begin() as conn:
            restored = dict(conn.execute(select(documents.c.document_key, documents.c.payload)).all())
        assert restored["audit"] == all_history
        assert restored["conversations"] == [binding]
        assert restored["secrets"] == encrypted
        command.upgrade(config(), "head")
        assert store.audit_events() == all_history
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "record_key,invalid",
    [
        ("audit", {"unexpected": "object, not an array"}),
        ("audit", [1]),
        ("audit", [{"integrationId": 123}]),
        ("conversations", [{"key": "k"}]),
        ("conversations", [{"key": "k", "sessionId": "thread"}] * 2),
    ],
)
def test_chat_records_migration_rejects_bad_legacy_data_atomically(migrated_schema, record_key, invalid):
    url, _ = migrated_schema
    engine = create_engine(url)
    try:
        command.downgrade(config(), OLD_REVISION)
        put_documents(engine, {record_key: invalid})
        with pytest.raises(DBAPIError, match="Legacy chat"):
            command.upgrade(config(), "head")
        with engine.begin() as conn:
            assert conn.scalar(select(documents.c.payload).where(documents.c.document_key == record_key)) == invalid
            assert conn.scalar(text("SELECT version_num FROM alembic_version")) == OLD_REVISION
        assert "chat_audit_events" not in inspect(engine).get_table_names()
        put_documents(engine, {record_key: []})
        command.upgrade(config(), "head")
        assert "chat_audit_events" in inspect(engine).get_table_names()
    finally:
        engine.dispose()


def test_chat_startup_requires_record_migration_and_no_stale_legacy_copies(migrated_schema):
    url, _ = migrated_schema
    engine = create_engine(url)
    store = DatabaseChatIntegrationStore(url)
    try:
        store.verify_schema()
        command.downgrade(config(), OLD_REVISION)
        with pytest.raises(RuntimeError, match="Run backend migrations"):
            store.verify_schema()
        command.upgrade(config(), "head")
        put_documents(engine, {"audit": []})
        with pytest.raises(RuntimeError, match="Legacy chat records require"):
            store.verify_schema()
    finally:
        engine.dispose()
