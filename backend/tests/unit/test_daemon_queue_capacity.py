"""Durable queue saturation is a retryable Computer capacity wait."""

from uuid import uuid4

import pytest

from relay.agents.routing import dispatch_failure_code
from relay.core.ids import now_iso
from relay.core.daemon_records import ComputerRunCapacityError
from store_fixtures import make_daemon_store


def test_full_queue_reports_capacity_and_accepts_work_after_release(tmp_path):
    store = make_daemon_store(tmp_path)
    node_id = str(uuid4())
    store.register_node({
        "id": node_id, "status": "ready", "agents": {"codex": "ready"},
        "maxConcurrentRuns": 1, "createdAt": now_iso(), "updatedAt": now_iso(),
    })

    def request():
        return {
            "nodeId": node_id, "sessionId": str(uuid4()), "taskGoal": "work",
            "assignments": [{"agent": "codex"}], "state": {},
        }

    first, _second = [store.create_run_request(request()) for _ in range(2)]
    overflow = request()
    with pytest.raises(ComputerRunCapacityError) as caught:
        store.create_run_request(overflow)
    assert dispatch_failure_code(caught.value) == "capacity_exhausted"
    assert len(store.list_active_run_requests(node_id)) == 2
    store.update_run_request(first["id"], {"status": "cancelled"})
    assert store.create_run_request(overflow)["sessionId"] == overflow["sessionId"]
