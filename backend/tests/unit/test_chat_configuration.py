"""Integration settings and credentials are isolated by aggregate, not fleet."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event, get_ident

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import event

from postgres_backend import disposable_postgres_url
from relay.persistence.chat.store import DatabaseChatIntegrationStore
from store_fixtures import make_chat_store


@pytest.mark.parametrize("operation", ["list", "get", "settings", "update"])
def test_chat_reads_and_writes_use_only_selected_credentials(tmp_path, monkeypatch, operation):
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", Fernet.generate_key().decode())
    store = make_chat_store(tmp_path)
    integrations = [
        store.create_integration({"provider": "discord", "secrets": {"botToken": f"credential-{i}"}}) for i in range(8)
    ]
    decrypted = []
    decrypt = store._secret_cipher.decrypt

    def record(*args, **kwargs):
        plain = decrypt(*args, **kwargs)
        decrypted.append(json.loads(plain))
        return plain

    monkeypatch.setattr(store._secret_cipher, "decrypt", record)
    selected = integrations[0]["id"]
    if operation == "list":
        assert len(store.list_integrations()) == 8
    elif operation == "get":
        assert store.get_integration(selected)["secretKeys"] == ["botToken"]
    elif operation == "settings":
        assert store.connection_settings(selected)["secrets"] == {"botToken": "credential-0"}
    else:
        updated = store.update_integration(selected, {"secrets": {"signingSecret": "new"}})
        assert updated["secretKeys"] == ["botToken", "signingSecret"]
    assert decrypted == ([{"botToken": "credential-0"}] if operation in {"settings", "update"} else [])


@pytest.mark.postgres
@pytest.mark.parametrize("same_store", [False, True])
@pytest.mark.parametrize("with_credentials", [False, True])
def test_different_integrations_mutate_independently(same_store, with_credentials, monkeypatch):
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", Fernet.generate_key().decode())
    with disposable_postgres_url() as url:
        first = DatabaseChatIntegrationStore(url)
        second = first if same_store else DatabaseChatIntegrationStore(url)
        a = first.create_integration({"provider": "discord"})
        b = second.create_integration({"provider": "discord"})
        paused, release, attempted = Event(), Event(), Event()
        writer = []

        def pause_write(conn, cursor, statement, *args):
            if writer and get_ident() == writer[0] and statement.startswith("UPDATE chat_") and not paused.is_set():
                paused.set()
                assert release.wait(5)

        def change_first():
            writer.append(get_ident())
            return first.update_integration(
                a["id"], {"displayName": "first", **({"secrets": {"botToken": "first"}} if with_credentials else {})}
            )

        def change_second():
            attempted.set()
            return second.update_integration(
                b["id"], {"displayName": "second", **({"secrets": {"botToken": "second"}} if with_credentials else {})}
            )

        event.listen(first.engine, "before_cursor_execute", pause_write)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                one = pool.submit(change_first)
                try:
                    assert paused.wait(5)
                    two = pool.submit(change_second)
                    assert attempted.wait(5)
                    assert two.result(timeout=0.5)["displayName"] == "second"
                finally:
                    release.set()
                one.result(timeout=5)
        finally:
            event.remove(first.engine, "before_cursor_execute", pause_write)
        assert first.get_integration(a["id"])["displayName"] == "first"
        if with_credentials:
            assert first.connection_settings(a["id"])["secrets"]["botToken"] == "first"
            assert second.connection_settings(b["id"])["secrets"]["botToken"] == "second"


@pytest.mark.parametrize("operation", ["list", "runtime", "get", "settings"])
def test_unused_legacy_secrets_do_not_require_a_key(tmp_path, monkeypatch, operation):
    from datetime import UTC, datetime
    from sqlalchemy import insert
    from relay.persistence.tables.chat import documents

    monkeypatch.delenv("RELAY_CHAT_SECRET_KEY", raising=False)
    store = make_chat_store(tmp_path)
    envelope = Fernet(Fernet.generate_key()).encrypt(b'{"orphan":{"botToken":"old"}}').decode()
    with store.engine.begin() as conn:
        conn.execute(
            insert(documents).values(
                document_key="secrets", payload={"ciphertext": envelope}, updated_at=datetime.now(UTC)
            )
        )
    if operation == "list":
        assert store.list_integrations() == []
    elif operation == "runtime":
        assert store.runtime_integrations() == []
    else:
        with pytest.raises(KeyError):
            (store.get_integration if operation == "get" else store.connection_settings)("missing")
