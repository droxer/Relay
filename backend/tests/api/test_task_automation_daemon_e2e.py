"""Standalone and Project work reaches the real daemon through manual/scheduled starts."""
import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from automation_helpers import DAILY_TRIGGERS
from daemon_e2e import DaemonE2E, eventually


@pytest.fixture
def task_daemon(tmp_path, monkeypatch):
    h = DaemonE2E(tmp_path, monkeypatch)
    try:
        h.setup()
        yield h
    finally:
        h.close()


@pytest.mark.integration
@pytest.mark.parametrize("scope", ["standalone", "project"])
@pytest.mark.parametrize("entry", ["task", "manual", "schedule", "webhook"])
def test_task_and_automation_execution_scope_and_occurrence_ledger(task_daemon, scope, entry):
    h = task_daemon
    scheduler = h.scheduler()
    automation = entry != "task"
    source = h.post("/tasks", {
        "title": f"{scope} {entry}", "assignedAgentId": h.agent["id"],
        "acceptancePolicy": "automatic",
        **({"projectId": h.project["id"]} if scope == "project" else {"computerId": h.agent["computerId"]}),
        **({"isRoutine": True, "routineState": "active",
            "routineTriggers": [{"kind": "webhook"}] if entry == "webhook" else DAILY_TRIGGERS}
           if automation else {}),
    }, 201)
    if entry in ("schedule", "webhook"):
        if entry == "webhook":
            secret = h.post(f"/tasks/{source['id']}/automation/webhook-secret", {}, 201)["secret"]
            response = h.client.post(f"/api/v1/automations/{source['id']}/webhook",
                                     json={"ref": "main"}, headers={"X-Relay-Automation-Token": secret})
            assert response.status_code == 202, response.text
        else:
            scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2))
        asyncio.run(scheduler.tick())
        task, = [item for item in h.ctx.task_store.list_tasks() if item.get("sourceRoutineId") == source["id"]]
        sid, = task["linkedSessionIds"]
    else:
        response = h.post(f"/tasks/{source['id']}/runs", {}, 202)
        assert response["dispatch"]["state"] == "started", response
        task, sid = response["task"], response["session"]["id"]
    completed = h.settled(sid, 1)
    finished = eventually(lambda: (item if (item := h.ctx.task_store.get_task(task["id"]))["status"] == "done" else None))
    assert finished["linkedSessionIds"] == [sid]
    assert completed.get("projectId") == (h.project["id"] if scope == "project" else None)
    assert not completed.get("teamId")
    launch, = [item for item in h.traces() if item["kind"] == "launch"]
    command = h.ctx.daemon_store.get_command(launch["commandId"])["command"]
    assert command["workspaceScope"]["taskId"] == task["id"]
    if scope == "project":
        assert command["workspaceLayout"] == "project"
        assert command["workspaceSubpath"] == h.project["workspaceSubpath"]
    else:
        assert command["workspaceLayout"] == "task"
        assert source["id"] in command["workspaceSubpath"]
    assert not h.ctx.daemon_store.list_active_runs(h.node_id)
    # A settled occurrence never becomes a second execution on another tick.
    asyncio.run(scheduler.tick())
    assert len([item for item in h.traces() if item["kind"] == "launch"]) == 1
    response = h.client.get(f"/api/v1/tasks/{source['id']}/runs")
    assert response.status_code == 200, response.text
    row, = response.json()["runs"]
    assert row["taskId"] == task["id"]
    assert row["status"] == "done" and row["endedAt"]
    assert row["sessionIds"] == [sid]
    if automation:
        assert task["id"] != source["id"]
        assert finished["sourceRoutineId"] == source["id"]
        assert row["triggerKind"] == entry
        definition = h.ctx.task_store.get_task(source["id"])
        assert definition["routineState"] == "active"
        assert not definition.get("executionOwner")
