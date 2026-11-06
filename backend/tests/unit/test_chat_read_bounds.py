"""Public metadata avoids decryption; runtime lists decrypt only selected rows."""

import json

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import event

from store_fixtures import make_chat_store


@pytest.mark.parametrize("view", ["public", "runtime"])
def test_chat_lists_batch_secret_document_reads(tmp_path, monkeypatch, view):
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", Fernet.generate_key().decode())
    store = make_chat_store(tmp_path)
    for index in range(8):
        integration = store.create_integration(
            {
                "provider": "discord",
                "displayName": str(index),
                "secrets": {"botToken": f"credential-{index}"},
            }
        )
        store.add_identity_link(integration["id"], {"externalUserId": "external", "userId": "owner"})
        store.add_allowed_conversation(integration["id"], {"conversationId": "conversation"})
        store.check_integration(integration["id"], provider_health=(True, "healthy"))
        store.activate_integration(integration["id"])
    statements, decryptions = [], []
    decrypt = store._secret_cipher.decrypt

    def record_decrypt(*args, **kwargs):
        decryptions.append(True)
        return decrypt(*args, **kwargs)

    def record_sql(conn, cursor, statement, *args):
        if statement.startswith("SELECT"):
            statements.append(statement)

    monkeypatch.setattr(store._secret_cipher, "decrypt", record_decrypt)
    event.listen(store.engine, "before_cursor_execute", record_sql)
    try:
        result = store.list_integrations() if view == "public" else store.runtime_integrations()
    finally:
        event.remove(store.engine, "before_cursor_execute", record_sql)
    assert len(result) == 8
    assert len(statements) <= 2, "one legacy marker lookup and one joined record query per list"
    assert len(decryptions) == (0 if view == "public" else 8)
    if view == "public":
        assert all(item["secretConfigured"] and item["secretKeys"] == ["botToken"] for item in result)
        assert "credential-" not in json.dumps(result)
    else:
        assert {item["secrets"]["botToken"] for item in result} == {f"credential-{index}" for index in range(8)}
