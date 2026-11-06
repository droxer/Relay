"""Full thread lists scope before hydrating history and bound SQL parameters."""

from sqlalchemy import event

from relay.persistence.events import relay_event
from store_fixtures import make_session_store
from user_ids import user_id


def test_full_thread_list_filters_owner_and_archive_before_hydration(tmp_path, monkeypatch):
    store = make_session_store(tmp_path)
    alice, bob = user_id("alice"), user_id("bob")
    visible = store.create_session({"workspacePath": "/work", "taskGoal": "visible", "ownerUserId": alice})
    archived = store.create_session({"workspacePath": "/work", "taskGoal": "archived", "ownerUserId": alice})
    store.append_event(archived["id"], relay_event("session.archived", archived["id"], {}))
    foreign = store.create_session({"workspacePath": "/work", "taskGoal": "foreign", "ownerUserId": bob})
    unowned = store.create_session({"workspacePath": "/work", "taskGoal": "unowned"})
    hydrated = []
    from relay.persistence.session import reads
    original = reads.hydrate_session_logs

    def hydrate(snapshot, events):
        hydrated.append(snapshot["id"])
        return original(snapshot, events)

    monkeypatch.setattr(reads, "hydrate_session_logs", hydrate)
    [result] = store.list_sessions(owner_user_id=alice, include_archived=False)
    assert result == store.get_session(visible["id"])
    assert set(hydrated) == {visible["id"]}
    assert {s["id"] for s in store.list_sessions(owner_user_id=alice)} == {visible["id"], archived["id"]}
    assert {s["id"] for s in store.list_sessions()} == {visible["id"], archived["id"], foreign["id"], unowned["id"]}


def test_full_thread_list_batches_event_parameters_and_keeps_all_records(tmp_path):
    store = make_session_store(tmp_path)
    for index in range(503):
        store.create_session({"workspacePath": "/work", "taskGoal": str(index)})
    statements = []

    def record(conn, cursor, statement, parameters, *args):
        if statement.startswith("SELECT"):
            statements.append((statement, parameters))

    event.listen(store.engine, "before_cursor_execute", record)
    try:
        result = store.list_sessions()
    finally:
        event.remove(store.engine, "before_cursor_execute", record)
    assert len(result) == 503
    assert all(s["events"] and s["eventCount"] == len(s["events"]) for s in result)
    assert max(len(parameters) for _, parameters in statements) <= 500
    assert len(statements) == 3, "one snapshot query and two bounded history batches"
