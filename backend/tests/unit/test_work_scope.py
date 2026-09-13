from copy import deepcopy

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
