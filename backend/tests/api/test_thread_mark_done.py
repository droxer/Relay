"""A person's mark done on a task thread settles its task.

The round has already closed on the task by the time the decision bar shows,
so mark done must reach a task awaiting review or blocked by a failure, not
only one still in flight.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer

DONE_REPORT = {"status": "done", "work": {"status": "done", "evidence": ["Checked"]}}
BLOCKED_REPORT = {"status": "blocked", "question": "Which branch?"}


def _finished_task_round(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any, *, policy: str,
    report: dict[str, Any] | None, failed: bool,
) -> tuple[TestClient, dict[str, Any], str]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice_project", "project-computer")
    lead = _agent(client, app, node, "Lead", "codex")
    _login_alice(client)
    project = client.post("/api/v1/projects", json={
        "name": "Mark done", "daemonNodeId": node["id"], "leadAgentId": lead["id"],
        "members": [{"agentId": lead["id"], "role": "implementer",
                     "responsibilities": "Deliver", "enabled": True}],
    }).json()["project"]
    task = client.post("/api/v1/tasks", json={
        "title": "Do it", "projectId": project["id"], "assignedAgentId": lead["id"],
        "status": "assigned", "acceptancePolicy": policy,
    }).json()
    started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert started.json()["dispatch"]["state"] == "started", started.text
    token = f"token_{node['id']}"
    [command] = app.state.registry.take_commands(node["id"], token)
    base = {
        "commandId": command["id"],
        **({"leaseId": command["leaseId"]} if command.get("leaseId") else {}),
        "sessionId": command["sessionId"], "runId": command["runId"],
        "agent": command["agent"],
    }
    app.state.registry.handle_event(node["id"], {"type": "run.executing", **base}, token)
    event = (
        {"type": "run.failed", **base, "exitCode": 1, "error": "boom"}
        if failed
        else {"type": "run.completed", **base, "exitCode": 0, "agentLog": "done"}
    )
    if report:
        event["roundResult"] = report
    app.state.registry.handle_event(node["id"], event, token)
    return client, task, command["sessionId"]


@pytest.mark.parametrize(
    "policy,report,failed,before",
    [
        ("human", DONE_REPORT, False, "review"),
        ("human", None, False, "review"),
        ("automatic", BLOCKED_REPORT, False, "waiting_for_human"),
        ("automatic", None, True, "blocked"),
    ],
)
def test_mark_done_settles_the_rounds_task(
    monkeypatch, tmp_path, policy, report, failed, before
):
    client, task, thread_id = _finished_task_round(
        monkeypatch, tmp_path, policy=policy, report=report, failed=failed
    )
    assert client.get(f"/api/v1/tasks/{task['id']}").json()["status"] == before

    response = client.post(
        f"/api/v1/threads/{thread_id}/decisions", json={"kind": "mark_done"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert client.get(f"/api/v1/tasks/{task['id']}").json()["status"] == "done"


def test_cancel_leaves_a_reviewed_task_in_review(monkeypatch, tmp_path):
    client, task, thread_id = _finished_task_round(
        monkeypatch, tmp_path, policy="human", report=DONE_REPORT, failed=False
    )

    response = client.post(
        f"/api/v1/threads/{thread_id}/decisions", json={"kind": "cancel"}
    )

    assert response.status_code == 200, response.text
    assert client.get(f"/api/v1/tasks/{task['id']}").json()["status"] == "review"
