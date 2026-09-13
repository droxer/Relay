from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from relay.persistence.store_common import relay_task_event
from relay.persistence.task_store import DatabaseTaskStore, LocalTaskStore


@pytest.fixture(params=["local", "database"])
def store(request, tmp_path):
    if request.param == "local":
        return LocalTaskStore(str(tmp_path))
    return DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True)


def claim(store, task_id, request_id, revision):
    return store.append_event(task_id, relay_task_event(
        "task.execution.claimed", task_id,
        {"requestId": request_id, "expectedRevision": revision},
    ))


def test_execution_revision_survives_completion_and_rejects_old_owner(store):
    task_id = store.create_task({"title": "Owned work"})["id"]
    first = claim(store, task_id, "first", 0)
    assert first["executionOwner"] == {"requestId": "first", "revision": 1}
    assert claim(store, task_id, "first", 0) == first
    second = claim(store, task_id, "second", 1)
    assert second["executionOwner"] == {"requestId": "second", "revision": 2}
    completed = store.append_event(task_id, relay_task_event(
        "task.status", task_id, {"status": "done"},
    ))
    stale = store.append_events(task_id, [relay_task_event(
        "task.status", task_id, {"status": "running"},
    )], execution_owner=first["executionOwner"])
    assert stale == completed
    assert store.record_round(task_id, round_count=99, execution_owner=first["executionOwner"]) == completed
    assert store.record_activity(task_id, "stale result", execution_owner=first["executionOwner"]) == completed
    with pytest.raises(ValueError, match="task_ownership_changed"):
        claim(store, task_id, "first", 0)
    assert store.get_task(task_id) == completed


def test_only_one_claim_can_advance_the_same_revision(store):
    task_id = store.create_task({"title": "Race ownership"})["id"]
    barrier = Barrier(2)

    def compete(request_id):
        barrier.wait()
        try:
            claim(store, task_id, request_id, 0)
            return True
        except ValueError as error:
            assert "task_ownership_changed" in str(error)
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(compete, ["first", "second"])) == [False, True]
    assert store.get_task(task_id)["executionOwner"]["revision"] == 1


def test_legacy_execution_writes_stop_after_first_versioned_owner(store):
    task_id = store.create_task({"title": "Legacy work"})["id"]
    legacy = {"requestId": "legacy", "revision": 0}
    event = relay_task_event("task.status", task_id, {"status": "running"})
    assert store.append_events(task_id, [event], execution_owner=legacy)["status"] == "running"
    owned = claim(store, task_id, "new", 0)
    assert store.append_events(task_id, [event], execution_owner=legacy) == owned


@pytest.mark.parametrize("revision", [-1, True, None, "0"])
def test_invalid_claim_cannot_change_task(store, revision):
    task = store.create_task({"title": "Valid ownership only"})
    with pytest.raises(ValueError, match="task_ownership_changed"):
        claim(store, task["id"], "owner", revision)
    assert store.get_task(task["id"]) == task


def test_claim_cannot_be_batched_with_an_unguarded_write(store):
    task = store.create_task({"title": "Separate ownership transition"})
    with pytest.raises(ValueError, match="task_ownership_changed"):
        store.append_events(task["id"], [
            relay_task_event("task.execution.claimed", task["id"], {"requestId": "owner", "expectedRevision": 0}),
            relay_task_event("task.status", task["id"], {"status": "done"}),
        ])
    assert store.get_task(task["id"]) == task


def test_database_claim_uses_authoritative_events_if_legacy_snapshot_lacks_owner(tmp_path):
    from sqlalchemy import select, update

    store = DatabaseTaskStore(f"sqlite:///{tmp_path}/legacy.db", create_schema=True)
    task_id = store.create_task({"title": "Old projection"})["id"]
    owned = claim(store, task_id, "current", 0)
    with store.engine.begin() as conn:
        snapshot = dict(conn.scalar(select(store.tasks.c.snapshot).where(store.tasks.c.id == task_id)))
        snapshot.pop("executionOwner")
        conn.execute(update(store.tasks).where(store.tasks.c.id == task_id).values(snapshot=snapshot))
    with pytest.raises(ValueError, match="task_ownership_changed"):
        claim(store, task_id, "stale", 0)
    assert store.get_task(task_id) == owned
