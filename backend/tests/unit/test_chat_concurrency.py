"""Independent control-plane stores must not overwrite one another's documents."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from cryptography.fernet import Fernet

from postgres_backend import disposable_postgres_url
from relay.chat.integrations import DatabaseChatIntegrationStore


@pytest.mark.postgres
@pytest.mark.parametrize("operation", ["create", "update", "conversation", "secrets"])
def test_chat_document_mutations_serialize_before_reading(monkeypatch, operation):
    monkeypatch.setenv("RELAY_CHAT_SECRET_KEY", Fernet.generate_key().decode())
    with disposable_postgres_url() as url:
        first = DatabaseChatIntegrationStore(url)
        second = DatabaseChatIntegrationStore(url)
        seed = first.create_integration({"provider": "discord", "displayName": "original"})
        other = first.create_integration({"provider": "discord"}) if operation == "secrets" else None
        conversation = {"provider": "discord", "conversationId": "seed"}
        first.set_conversation_session(conversation, "seed-thread", "owner")
        document_key = "conversations" if operation == "conversation" else "integrations"
        paused, release, attempted, second_read = (Event() for _ in range(4))
        original_first, original_second = first._read_document, second._read_document

        def pause_first(key, default):
            result = original_first(key, default)
            if key == document_key and not paused.is_set():
                paused.set()
                assert release.wait(5), "first writer was not released"
            return result

        def observe_second(key, default):
            if key == document_key:
                second_read.set()
            return original_second(key, default)

        monkeypatch.setattr(first, "_read_document", pause_first)
        monkeypatch.setattr(second, "_read_document", observe_second)

        def mutate(store, index):
            if index == 2:
                attempted.set()
            if operation == "create":
                return store.create_integration({"provider": "discord", "displayName": str(index)})
            if operation == "secrets":
                record_id = seed["id"] if index == 1 else other["id"]
                return store.update_integration(record_id, {"secrets": {"botToken": f"token-{index}"}})
            if operation == "update":
                patch = {"displayName": "updated"} if index == 1 else {"tenantId": "tenant"}
                return store.update_integration(seed["id"], patch)
            return store.set_conversation_session(
                {**conversation, "conversationId": str(index)}, f"thread-{index}", "owner"
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(mutate, first, 1)
            try:
                assert paused.wait(5)
                b = pool.submit(mutate, second, 2)
                assert attempted.wait(5)
                read_stale_state = second_read.wait(0.2)
            finally:
                release.set()
            a.result(timeout=5)
            b.result(timeout=5)
        assert not read_stale_state, "another store read mutable state before the first committed"
        if operation == "create":
            assert {i["displayName"] for i in first.list_integrations()} == {"original", "1", "2"}
            assert len(first.audit_events()) == 3
        elif operation == "update":
            result = first.get_integration(seed["id"])
            assert (result["displayName"], result["tenantId"]) == ("updated", "tenant")
            assert len(first.audit_events()) == 3
        elif operation == "secrets":
            assert first.connection_settings(seed["id"])["secrets"]["botToken"] == "token-1"
            assert first.connection_settings(other["id"])["secrets"]["botToken"] == "token-2"
            assert len(first.audit_events()) == 4
        else:
            for index in (1, 2):
                result = first.get_conversation_session({**conversation, "conversationId": str(index)})
                assert result["sessionId"] == f"thread-{index}"


@pytest.mark.postgres
def test_chat_reader_progresses_with_a_one_connection_pool(monkeypatch):
    """A queued write must not consume the connection its preceding read needs."""
    from sqlalchemy import create_engine, event

    with disposable_postgres_url() as url:
        store = DatabaseChatIntegrationStore(url)
        integration = store.create_integration({"provider": "discord"})
        engine = create_engine(url, pool_size=1, max_overflow=0, pool_timeout=0.5)
        store.engine = engine
        paused, release, attempted, acquired_connection = (Event() for _ in range(4))
        original = store._read_document

        def pause_read(key, default):
            if key == "integrations" and not paused.is_set():
                paused.set()
                assert release.wait(5)
            return original(key, default)

        def observe_guard(conn, cursor, statement, *args):
            if "pg_try_advisory_xact_lock" in statement:
                acquired_connection.set()

        monkeypatch.setattr(store, "_read_document", pause_read)
        event.listen(engine, "before_cursor_execute", observe_guard)

        def update():
            attempted.set()
            return store.update_integration(integration["id"], {"config": {"applicationId": "updated"}})

        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                read = pool.submit(store.get_integration, integration["id"])
                try:
                    assert paused.wait(5)
                    write = pool.submit(update)
                    assert attempted.wait(5)
                    acquired_connection.wait(0.2)
                finally:
                    release.set()
                assert read.result(timeout=5)["id"] == integration["id"]
                assert write.result(timeout=5)["config"]["applicationId"] == "updated"
        finally:
            engine.dispose()
