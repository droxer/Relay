"""Dispatch capacity is durable across backend processes, including staged work."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest

from postgres_backend import disposable_postgres_url
from relay.persistence.daemon.store import DatabaseDaemonStore
from relay.core.ids import now_iso


@pytest.mark.postgres
@pytest.mark.parametrize("capacity", [1, 3])
def test_replicas_compete_for_dispatch_slots(capacity):
    with disposable_postgres_url() as url:
        first, second = DatabaseDaemonStore(url), DatabaseDaemonStore(url)
        node_id = str(uuid4())
        first.register_node({
            "id": node_id, "status": "ready", "agents": {"codex": "ready"},
            "maxConcurrentRuns": capacity,
            "createdAt": now_iso(), "updatedAt": now_iso(),
        })
        requests = [first.create_run_request({
            "nodeId": node_id, "sessionId": str(uuid4()), "taskGoal": "race",
            "assignments": [{"agent": "codex"}], "state": {},
        }) for _ in range(capacity * 2)]
        ready = Barrier(len(requests))

        def claim(store, request):
            ready.wait(timeout=5)
            return store.claim_run_request_dispatch(request["id"], str(uuid4()), 30)

        with ThreadPoolExecutor(max_workers=len(requests)) as pool:
            futures = [pool.submit(claim, first if index % 2 else second, request)
                       for index, request in enumerate(requests)]
            results = [future.result(timeout=10) for future in futures]
        assert sum(result is not None for result in results) == capacity
        winner = next(result for result in results if result is not None)
        winners = {result["id"] for result in results if result is not None}
        loser = next(request for request in requests if request["id"] not in winners)
        # Staging the winner and releasing its claim must still reserve a slot:
        # an unpublished command can be recovered and run after a crash.
        command = {
            "id": str(uuid4()), "type": "run.start", "runId": str(uuid4()),
            "sessionId": winner["sessionId"], "agent": "codex", "taskGoal": "race",
        }
        assert first.stage_command(node_id, command, request_id=winner["id"],
                                   claim_id=winner["state"]["_relay_dispatch_claim_id"])
        first.update_run_request(winner["id"], {"status": "running"})
        assert second.claim_run_request_dispatch(loser["id"], str(uuid4()), 30) is None
