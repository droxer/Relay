from types import SimpleNamespace

import pytest

from relay.collaboration.models import COLLABORATION_MANIFEST_STATE_KEY
from relay.persistence.store_common import relay_task_event
from relay.persistence.task_store import LocalTaskStore
from relay.sessions.task_scope import thread_task_scope


@pytest.fixture
def scoped_task(tmp_path):
    store = LocalTaskStore(str(tmp_path))
    task = store.create_task({"title": "Scoped task", "status": "running"})
    manifest = {"roundId": "round_1", "workScope": {"kind": "task", "taskId": task["id"]}}
    session = {"id": "thread_1", "activeRoundId": "round_1", "collaborationRounds": [manifest]}
    return store, task, session, manifest


def test_round_claim_survives_request_pruning_and_fences_racing_claim(scoped_task):
    store, task, session, manifest = scoped_task
    claimed = store.append_event(task["id"], relay_task_event(
        "task.execution.claimed", task["id"], {"requestId": "first", "expectedRevision": 0},
    ))
    manifest["taskExecutionOwner"] = claimed["executionOwner"]
    task_id, owner = thread_task_scope(session, None, store)
    assert (task_id, owner) == (task["id"], claimed["executionOwner"])
    newer = store.append_event(task["id"], relay_task_event(
        "task.execution.claimed", task["id"], {"requestId": "second", "expectedRevision": 1},
    ))
    store.append_event(task_id, relay_task_event("task.status", task_id, {"status": "done"}), execution_owner=owner)
    assert store.get_task(task_id) == newer
    assert thread_task_scope(session, None, store) == (None, None)


@pytest.mark.parametrize("mismatch", [None, "sessionId", "taskId", "roundId", "revision", "pruned"])
def test_historical_round_requires_matching_retained_request(scoped_task, mismatch):
    store, task, session, manifest = scoped_task
    claimed = store.append_event(task["id"], relay_task_event(
        "task.execution.claimed", task["id"], {"requestId": "first", "expectedRevision": 0},
    ))
    request = {"id": "first", "sessionId": session["id"], "taskId": task["id"], "state": {
        "_relay_task_execution_revision": 1, COLLABORATION_MANIFEST_STATE_KEY: dict(manifest),
    }}
    if mismatch in ("sessionId", "taskId"):
        request[mismatch] = "other"
    elif mismatch == "roundId":
        request["state"][COLLABORATION_MANIFEST_STATE_KEY]["roundId"] = "other"
    elif mismatch == "revision":
        request["state"]["_relay_task_execution_revision"] = 0
    daemon_store = SimpleNamespace(get_run_request=lambda _: None if mismatch == "pruned" else request)
    expected = (task["id"], claimed["executionOwner"]) if mismatch is None else (None, None)
    assert thread_task_scope(session, None, store, daemon_store) == expected


def test_legacy_round_is_fenced_against_first_claim(scoped_task):
    store, task, session, _ = scoped_task
    task_id, owner = thread_task_scope(session, None, store)
    assert task_id == task["id"]
    assert owner["revision"] == 0
    claimed = store.append_event(task_id, relay_task_event(
        "task.execution.claimed", task_id, {"requestId": "first", "expectedRevision": 0},
    ))
    store.append_event(task_id, relay_task_event("task.status", task_id, {"status": "done"}), execution_owner=owner)
    assert store.get_task(task_id) == claimed


def test_recorded_legacy_request_owner_is_accepted_without_claim(scoped_task):
    store, task, session, manifest = scoped_task
    manifest["taskExecutionOwner"] = {"requestId": "legacy", "revision": 0}
    assert thread_task_scope(session, None, store) == (task["id"], manifest["taskExecutionOwner"])


@pytest.mark.parametrize("status", ["done", "review", "blocked", "cancelled"])
def test_settled_tasks_have_no_thread_scope(scoped_task, status):
    store, task, session, _ = scoped_task
    store.append_event(task["id"], relay_task_event("task.status", task["id"], {"status": status}))
    assert thread_task_scope(session, None, store) == (None, None)


def test_scope_requires_task_store_and_task_round(scoped_task):
    store, task, session, manifest = scoped_task
    assert thread_task_scope(session, None, None) == (None, None)
    manifest["workScope"] = {"kind": "thread"}
    assert thread_task_scope(session, None, store) == (None, None)
    manifest["workScope"] = {"kind": "task", "taskId": "missing"}
    assert thread_task_scope(session, None, store) == (None, None)


def test_undelivered_request_is_authority_without_a_round(scoped_task):
    store, task, _, _ = scoped_task
    request = {"id": "prepared", "taskId": task["id"], "state": {"_relay_task_execution_revision": 1}}
    assert thread_task_scope({}, request, store) == (task["id"], {"requestId": "prepared", "revision": 1})
