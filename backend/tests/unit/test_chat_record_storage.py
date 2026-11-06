"""Growing chat records use indexed rows rather than shared document rewrites."""

import pytest
from datetime import UTC, datetime
from sqlalchemy import event, insert, inspect, select, text

from relay.persistence.chat.store import DatabaseChatIntegrationStore
from relay.persistence.engine import create_all_tables, shared_engine
from relay.persistence.tables.chat import documents
from store_fixtures import make_chat_store


def reject_legacy_records(store, monkeypatch):
    original = store.engine.dialect.do_execute

    def execute(cursor, statement, parameters, context=None):
        assert "chat_documents.payload" not in statement, "operation loaded a legacy document payload"
        return original(cursor, statement, parameters, context)

    monkeypatch.setattr(store.engine.dialect, "do_execute", execute)


def test_audit_appends_and_filtered_tail_do_not_load_history(tmp_path, monkeypatch):
    store = make_chat_store(tmp_path)
    a = store.create_integration({"provider": "discord"})
    b = store.create_integration({"provider": "discord"})
    for index in range(12):
        store.update_integration(a["id"] if index % 2 else b["id"], {"displayName": str(index)})
    expected = store.audit_events(a["id"], limit=2)
    reject_legacy_records(store, monkeypatch)
    statements = []

    def record(conn, cursor, statement, *args):
        statements.append(statement)

    event.listen(store.engine, "before_cursor_execute", record)
    try:
        assert store.audit_events(a["id"], limit=2) == expected
        assert any("chat_audit_events" in s and "LIMIT" in s and "WHERE" in s for s in statements)
        statements.clear()
        store.update_integration(a["id"], {"displayName": "new"})
    finally:
        event.remove(store.engine, "before_cursor_execute", record)
    assert any(s.startswith("INSERT INTO chat_audit_events") for s in statements)
    assert not any("FROM chat_audit_events" in s for s in statements), "append must not replay audit history"
    assert len(store.audit_events(limit=0)) == 1
    assert store.audit_events(a["id"], limit=1)[0]["type"] == "chat.integration.updated"


def test_conversation_lookup_upsert_and_clear_do_not_load_other_bindings(tmp_path, monkeypatch):
    store = make_chat_store(tmp_path)
    base = {"provider": "discord", "conversationId": "selected", "messageId": "original"}
    original = store.set_conversation_session(base, "thread-1", "owner")
    store.set_conversation_session({**base, "conversationId": "also-selected"}, "thread-1", "owner")
    for index in range(20):
        store.set_conversation_session({**base, "conversationId": str(index)}, "other-thread", "owner")
    reject_legacy_records(store, monkeypatch)
    assert store.get_conversation_session(base) == original
    updated = store.set_conversation_session({**base, "messageId": ""}, "thread-2", "new-owner")
    assert updated["createdAt"] == original["createdAt"]
    assert updated["providerMessageId"] == "original"
    assert updated["ownerUserId"] == "new-owner"
    assert store.clear_conversation_sessions("thread-1") == 1
    assert store.get_conversation_session({**base, "conversationId": "also-selected"}) is None
    assert store.clear_conversation_sessions("thread-2") == 1
    assert store.get_conversation_session(base) is None
    assert store.get_conversation_session({**base, "conversationId": "0"})["sessionId"] == "other-thread"


def test_sqlite_startup_converts_legacy_records_without_touching_secrets(tmp_path):
    url = f"sqlite:///{tmp_path}/legacy.db"
    engine = shared_engine(url)
    create_all_tables(engine)
    history = [{"id": "duplicate-id", "integrationId": "chat-old", "timestamp": str(i), "extra": i} for i in range(3)]
    binding = {
        "key": "discord::::channel::",
        "provider": "discord",
        "conversationId": "channel",
        "sessionId": "old-thread",
        "ownerUserId": "owner",
        "extra": "keep",
    }
    encrypted = {"ciphertext": "untouched-envelope"}
    with engine.begin() as conn:
        conn.execute(
            insert(documents),
            [
                {"document_key": key, "payload": value, "updated_at": datetime.now(UTC)}
                for key, value in [("audit", history), ("conversations", [binding]), ("secrets", encrypted)]
            ],
        )
    store = DatabaseChatIntegrationStore(url, create_schema=True)
    assert {"chat_audit_events", "chat_conversations"} <= set(inspect(engine).get_table_names())
    assert store.audit_events() == history
    assert store.get_conversation_session({"provider": "discord", "conversationId": "channel"}) == binding
    with engine.begin() as conn:
        rows = dict(conn.execute(select(documents.c.document_key, documents.c.payload)).all())
    assert rows == {"secrets": encrypted}
    # Restart is idempotent and does not duplicate converted audit rows.
    assert DatabaseChatIntegrationStore(url, create_schema=True).audit_events() == history


@pytest.mark.parametrize(
    "key,payload,match",
    [
        ("audit", {"invalid": "object"}, "array"),
        ("audit", [1], "array"),
        ("audit", [{"integrationId": 123}], "integrationId"),
        ("conversations", [{"key": "k", "sessionId": ""}], "nonempty"),
        ("conversations", [{"key": "k", "sessionId": "s"}] * 2, "duplicate"),
    ],
)
def test_sqlite_legacy_conversion_rejects_invalid_records_atomically(tmp_path, key, payload, match):
    url = f"sqlite:///{tmp_path}/legacy.db"
    engine = shared_engine(url)
    create_all_tables(engine)
    with engine.begin() as conn:
        conn.execute(insert(documents).values(document_key=key, payload=payload, updated_at=datetime.now(UTC)))
    with pytest.raises(ValueError, match=match):
        DatabaseChatIntegrationStore(url, create_schema=True)
    with engine.begin() as conn:
        assert conn.scalar(select(documents.c.payload)) == payload
        assert conn.scalar(text("SELECT count(*) FROM chat_conversations")) == 0
        assert conn.scalar(text("SELECT count(*) FROM chat_audit_events")) == 0


def test_integration_mutation_and_audit_append_roll_back_together(tmp_path, monkeypatch):
    from relay.persistence.chat import store as integrations

    store = make_chat_store(tmp_path)
    integration = store.create_integration({"provider": "discord", "displayName": "before"})
    history = store.audit_events()
    append = integrations.append_audit_event

    def fail_after_append(*args):
        append(*args)
        raise RuntimeError("abort after audit insert")

    monkeypatch.setattr(integrations, "append_audit_event", fail_after_append)
    with pytest.raises(RuntimeError, match="abort after audit"):
        store.update_integration(integration["id"], {"displayName": "after"})
    assert store.get_integration(integration["id"]) == integration
    assert store.audit_events() == history


@pytest.mark.postgres
def test_long_external_conversation_keys_are_indexable_without_truncation():
    import hashlib
    from postgres_backend import disposable_postgres_url

    key = "".join(hashlib.sha256(str(i).encode()).hexdigest() for i in range(128))
    with disposable_postgres_url() as url:
        store = DatabaseChatIntegrationStore(url)
        payload = {"provider": "discord", "conversationId": key + "é"}
        first = store.set_conversation_session(payload, "thread-1", "owner")
        assert store.get_conversation_session(payload) == first
        second = store.set_conversation_session({**payload, "conversationId": key + "ê"}, "thread-2", "owner")
        assert store.get_conversation_session(payload)["sessionId"] == "thread-1"
        assert second["key"] != first["key"]
