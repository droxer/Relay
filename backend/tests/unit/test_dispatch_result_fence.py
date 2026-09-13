import asyncio
from types import SimpleNamespace

import pytest
from relay.persistence.task_store import DatabaseTaskStore, LocalTaskStore
from relay.services.task_dispatch import TaskDispatcher


@pytest.mark.parametrize("database", [False, True])
@pytest.mark.parametrize("outcome", ["success", "failure"])
def test_delayed_dispatch_result_cannot_overwrite_completed_task(tmp_path, database, outcome):
    tasks = DatabaseTaskStore(f"sqlite:///{tmp_path}/tasks.db", create_schema=True) if database else LocalTaskStore(str(tmp_path))
    task = tasks.create_task({"title": "Fast completion", "status": "assigned", "assignedAgent": "codex"})
    claimed = tasks.claim_task_for_dispatch(task["id"], "codex")

    async def run(*args):
        tasks.update_task(task["id"], {"status": "done"})
        if outcome == "failure":
            raise ValueError("workspace_unavailable: delayed refusal")
        return {"id": "completed-thread"}

    dispatcher = TaskDispatcher(SimpleNamespace(task_store=tasks, backend=SimpleNamespace(run=run)), claimed, {"isAdmin": True}, assignments=[], record_pending=True)
    dispatcher.agent = "codex"
    dispatcher.claim_id = claimed["dispatchClaim"]["id"]
    dispatcher._run_request = lambda node: {}
    asyncio.run(dispatcher._dispatch({"id": "node"}))
    final = tasks.get_task(task["id"])
    assert final["status"] == "done"
    assert not final.get("dispatchRetry")
    assert not final.get("dispatchOutcome")
    assert not any("started the task" in a["message"] for a in final["activity"])
