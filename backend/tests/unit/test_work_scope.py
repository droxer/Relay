from copy import deepcopy
from types import SimpleNamespace

import pytest

from relay.daemon_registry.node_backend import ServerDaemonNodeBackend


@pytest.mark.parametrize("task_id", [None, "original-task"])
def test_prepared_replay_preserves_original_work_scope(task_id):
    scope = {"kind": "task", "taskId": task_id} if task_id else {"kind": "thread"}
    manifest = {"roundId": "original-round", "workScope": scope}
    prepared = {
        "id": "request",
        "sessionId": "thread",
        "nodeId": "node",
        "taskId": task_id,
        "assignments": [],
        "state": {"_relay_collaboration_manifest": manifest},
    }
    submitted = {"sessionId": "thread", "taskId": "different-task"}
    before = deepcopy(prepared)

    resumed = ServerDaemonNodeBackend._resume_prepared_request(submitted, prepared)

    assert resumed["taskId"] == task_id
    assert resumed["collaboration"]["manifest"] == manifest
    assert prepared == before


@pytest.mark.parametrize(
    "source,revision,round_id,accepted",
    [
        (None, 8, "legacy", True),
        ({"revision": 0, "roundId": None}, 0, None, True),
        ({"revision": 2, "roundId": "source"}, 2, "source", True),
        ({"revision": 2, "roundId": "source"}, 3, "receiver", True),
        ({"revision": 2, "roundId": "source"}, 4, "receiver", False),
        ({"revision": 2, "roundId": "source"}, 3, "source", False),
        ({"revision": 2, "roundId": "source"}, 2, "different", False),
        ({"revision": True, "roundId": "source"}, 1, "source", False),
        ({"revision": -1}, 0, "receiver", False),
        ({}, 0, None, False),
        ("invalid", 0, None, False),
    ],
)
def test_recovery_ownership_revision(source, revision, round_id, accepted):
    updates = []
    backend = object.__new__(ServerDaemonNodeBackend)
    backend.registry = SimpleNamespace(daemon_store=SimpleNamespace(
        update_run_request_if_status=lambda *args: updates.append(args),
    ))
    request = {
        "id": "request",
        "state": {"_relay_collaboration_manifest": {
            "roundId": "receiver", "sourceOwnership": source,
        }},
    }
    session = {"collaborationRevision": revision, "activeRoundId": round_id}
    if accepted:
        backend._validate_source_ownership(request, session)
        assert updates == []
    else:
        with pytest.raises(ValueError, match="handoff_source_changed"):
            backend._validate_source_ownership(request, session)
        assert len(updates) == 1
        assert updates[0][:2] == ("request", "prepared")
        assert updates[0][2]["status"] == "failed"
