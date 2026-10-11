from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer


@pytest.fixture
def briefed_project(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice_context", "context-computer")
    lead = _agent(client, app, node, "Lead", "codex")
    _login_alice(client)
    created = client.post("/api/v1/projects", json={
        "name": "Website launch",
        "goal": "Ship the marketing site by Friday",
        "context": "Use Next.js; every page needs Lighthouse above 90.",
        "daemonNodeId": node["id"],
        "leadAgentId": lead["id"],
        "members": [{"agentId": lead["id"], "role": "planner",
                     "responsibilities": "Plan and build", "enabled": True}],
    })
    assert created.status_code == 201, created.text
    return app, client, node, created.json()["project"], lead


def test_project_stores_goal_and_context(briefed_project):
    _, client, _, project, _ = briefed_project

    assert project["goal"] == "Ship the marketing site by Friday"
    assert project["contextRevision"] == 1
    updated = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": project["version"], "context": "Use Astro instead.",
    })
    assert updated.status_code == 200, updated.text
    assert updated.json()["project"]["context"] == "Use Astro instead."
    assert updated.json()["project"]["contextRevision"] == 2


def test_project_task_run_tells_the_agent_about_the_project(briefed_project):
    app, client, node, project, lead = briefed_project
    task = client.post("/api/v1/tasks", json={
        "title": "Build the pricing page", "projectId": project["id"],
        "assignedAgentId": lead["id"], "status": "assigned",
    }).json()

    started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert started.status_code == 202, started.text
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")

    assert len(commands) == 1
    brief = commands[0]["state"]["project_brief"]
    assert brief.startswith("Project: Website launch")
    assert "Goal: Ship the marketing site by Friday" in brief
    assert "- Lead (planner, lead): Plan and build" in brief
    assert "Lighthouse above 90" in brief


def test_project_run_suggestions_wait_for_the_owner(briefed_project):
    app, client, node, project, lead = briefed_project
    task = client.post("/api/v1/tasks", json={
        "title": "Build the pricing page", "projectId": project["id"],
        "assignedAgentId": lead["id"], "status": "assigned",
    }).json()
    assert client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).status_code == 202
    daemon = TestClient(app)
    [command] = daemon.get(
        f"/api/v1/daemon-nodes/{node['id']}/commands?leaseMode=explicit&leaseSeconds=10",
        headers={"Authorization": f"Bearer token_{node['id']}"},
    ).json()["commands"]

    completed = daemon.post(
        f"/api/v1/daemon-nodes/{node['id']}/events",
        json={
            "type": "run.completed", "commandId": command["id"], "leaseId": command["leaseId"],
            "sessionId": command["sessionId"], "runId": command["runId"], "agent": command["agent"],
            "exitCode": 0, "agentLog": "Built it.",
            "roundResult": {"status": "done", "contextSuggestions": [
                {"text": "Pricing lives in content/pricing.json.", "evidence": "Created it this run"},
                {"text": "Use Next.js", "evidence": "already in the context"},
            ]},
        },
        headers={"Authorization": f"Bearer token_{node['id']}"},
    )
    assert completed.status_code == 200, completed.text

    latest = client.get(f"/api/v1/projects/{project['id']}").json()["project"]
    assert latest["context"] == project["context"], "suggestions never change the context themselves"
    [suggestion] = latest["contextSuggestions"]
    assert suggestion["text"] == "Pricing lives in content/pricing.json."
    assert suggestion["agentId"] == lead["id"]

    adopted = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": latest["version"],
        "context": latest["context"] + "\n- " + suggestion["text"],
        "resolveContextSuggestions": [suggestion["id"]],
    })
    assert adopted.status_code == 200, adopted.text
    assert adopted.json()["project"]["contextSuggestions"] == []
    assert adopted.json()["project"]["contextRevision"] == 2
