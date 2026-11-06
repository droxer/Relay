"""Independent control-plane stores must not overwrite one another's documents."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from postgres_backend import disposable_postgres_url
from relay.persistence.chat.store import DatabaseChatIntegrationStore


@pytest.mark.postgres
@pytest.mark.parametrize("same_store", [False, True])
def test_same_integration_patches_preserve_both_writers(same_store):
    from threading import get_ident
    from sqlalchemy import event

    with disposable_postgres_url() as url:
        first = DatabaseChatIntegrationStore(url)
        second = first if same_store else DatabaseChatIntegrationStore(url)
        integration = first.create_integration({"provider": "discord", "displayName": "original"})
        paused, release, attempted, second_read = (Event() for _ in range(4))
        writer = []

        def pause_selected(conn, cursor, statement, *args):
            if not statement.startswith("SELECT chat_integrations.payload"):
                return
            if writer and get_ident() == writer[0] and not paused.is_set():
                paused.set()
                assert release.wait(5)
            elif writer and get_ident() != writer[0]:
                second_read.set()

        def change_first():
            writer.append(get_ident())
            return first.update_integration(integration["id"], {"displayName": "updated"})

        def change_second():
            attempted.set()
            return second.update_integration(integration["id"], {"tenantId": "tenant"})

        event.listen(first.engine, "before_cursor_execute", pause_selected)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                one = pool.submit(change_first)
                try:
                    assert paused.wait(5)
                    two = pool.submit(change_second)
                    assert attempted.wait(5)
                    stale_read = second_read.wait(0.2)
                finally:
                    release.set()
                one.result(timeout=5)
                two.result(timeout=5)
            assert not stale_read
        finally:
            event.remove(first.engine, "before_cursor_execute", pause_selected)
        result = first.get_integration(integration["id"])
        assert (result["displayName"], result["tenantId"]) == ("updated", "tenant")
        assert len(first.audit_events()) == 3


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

        def observe_guard(conn, cursor, statement, *args):
            if statement.startswith("SELECT chat_integrations.payload") and not paused.is_set():
                paused.set()
                assert release.wait(5)
            if "pg_try_advisory_xact_lock" in statement:
                acquired_connection.set()

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


@pytest.mark.postgres
@pytest.mark.parametrize("same_key", [False, True])
def test_conversation_upserts_lock_only_the_selected_key(same_key):
    from threading import get_ident
    from concurrent.futures import TimeoutError
    from sqlalchemy import event

    with disposable_postgres_url() as url:
        first, second = DatabaseChatIntegrationStore(url), DatabaseChatIntegrationStore(url)
        paused, release, attempted = Event(), Event(), Event()
        first_thread = []
        a_payload = {"provider": "discord", "conversationId": "a"}
        b_payload = a_payload if same_key else {**a_payload, "conversationId": "b"}

        def pause_selected_read(conn, cursor, statement, *args):
            if (
                first_thread
                and get_ident() == first_thread[0]
                and "FROM chat_conversations" in statement
                and not paused.is_set()
            ):
                paused.set()
                assert release.wait(5)

        def write_first():
            first_thread.append(get_ident())
            return first.set_conversation_session(a_payload, "thread-a", "owner")

        def write_second():
            attempted.set()
            return second.set_conversation_session(b_payload, "thread-b", "owner")

        event.listen(first.engine, "before_cursor_execute", pause_selected_read)
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                a = pool.submit(write_first)
                try:
                    assert paused.wait(5)
                    b = pool.submit(write_second)
                    assert attempted.wait(5)
                    if same_key:
                        with pytest.raises(TimeoutError):
                            b.result(timeout=0.2)
                    else:
                        assert b.result(timeout=5)["sessionId"] == "thread-b"
                finally:
                    release.set()
                a.result(timeout=5)
                b.result(timeout=5)
        finally:
            event.remove(first.engine, "before_cursor_execute", pause_selected_read)
        assert first.get_conversation_session(a_payload)["sessionId"] == ("thread-b" if same_key else "thread-a")
        assert second.get_conversation_session(b_payload)["sessionId"] == "thread-b"
