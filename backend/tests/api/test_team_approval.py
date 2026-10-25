"""A team that asks its person to approve before the round's final step (ADR-023).

The round parks before the held turn without holding the computer, a typed
answer sends the work back to the turn before it, and an approval runs the
held turn in a round that keeps the evidence already filed.
"""

from __future__ import annotations

from tempfile import TemporaryDirectory
from typing import Any

from fastapi.testclient import TestClient

from relay.app import create_app
from relay.core.computer_identity import computer_id

from issue_projects import PROJECT_CAPABILITY, project_for_team
from user_ids import user_id

ALICE = user_id("alice")
NODE = "node_alice"


def _bootstrap(client: TestClient) -> None:
    assert client.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
    ).status_code == 200
    assert client.post(
        "/api/v1/admin/users",
        json={"userId": "alice", "username": "alice", "password": "userpass", "displayName": "Alice"},
    ).status_code == 201


def _agent(client: TestClient, name: str, executor: str, role: str) -> dict[str, Any]:
    node = client.app.state.registry.register({
        "sandboxId": "test_node_alice",
        "userId": ALICE,
        "workspaceId": "machine-alice",
        "token": "node_token",
        "workspacePath": "/workspace/alice",
        "protocolVersion": 1,
        "supportedAgents": ["claude", "codex"],
        "capabilities": [PROJECT_CAPABILITY, "task-workspaces", "thread-workspaces"],
        "status": "stopped",
    })
    response = client.post("/api/v1/admin/agents", json={
        "supervisorUserId": ALICE,
        "displayName": name,
        "executorKind": executor,
        "defaultRole": role,
        "computerId": computer_id(node),
    })
    assert response.status_code == 201
    agent = response.json()["agent"]
    assert client.post(
        f"/api/v1/admin/agents/{agent['id']}/placements", json={"daemonNodeId": NODE}
    ).status_code == 201
    return agent


def _finish(app: Any, *, agent_id: str) -> dict[str, Any]:
    """Run the one queued turn to a successful, reported end."""
    [command] = app.state.registry.take_commands(NODE, "node_token")
    assert command["logicalAgentId"] == agent_id
    base = {
        "commandId": command["id"],
        **({"leaseId": command["leaseId"]} if command.get("leaseId") else {}),
        "sessionId": command["sessionId"],
        "runId": command["runId"],
        "agent": command["agent"],
    }
    app.state.registry.handle_event(NODE, {"type": "run.executing", **base}, "node_token")
    report = (
        {"roundResult": {"status": "done", "work": {"status": "done", "evidence": ["Checked"]}}}
        if command.get("state", {}).get("work_result_required")
        else {}
    )
    app.state.registry.handle_event(
        NODE,
        {"type": "run.completed", **base, "exitCode": 0, "agentLog": "done", **report},
        "node_token",
    )
    return command


def _approval_team_task(client: TestClient) -> tuple[dict, dict, dict]:
    app = client.app
    app.state.registry.register({
        "sandboxId": NODE,
        "userId": ALICE,
        "token": "node_token",
        "workspacePath": "/workspace/alice",
        "protocolVersion": 1,
        "supportedAgents": ["codex", "claude"],
        "capabilities": [
            PROJECT_CAPABILITY, "task-workspaces", "thread-workspaces", "work-results", "round-result",
        ],
        "status": "ready",
    })
    builder = _agent(client, "Builder", "codex", "implementer")
    reviewer = _agent(client, "Reviewer", "claude", "reviewer")
    response = client.post("/api/v1/admin/teams", json={
        "ownerUserId": ALICE,
        "name": "Delivery",
        "leadAgentId": builder["id"],
        "memberAgentIds": [builder["id"], reviewer["id"]],
        "collaborationStyle": "build_review",
        "humanApproval": True,
    })
    assert response.status_code == 201
    team = response.json()["team"]
    assert team["humanApproval"] is True
    project = project_for_team(app, ALICE, team)
    task = client.post("/api/v1/tasks", json={
        "projectId": project["id"],
        "ownerUserId": ALICE,
        "title": "Build it and check it",
        "assigneeUserId": ALICE,
        "assignedTeamId": team["id"],
    }).json()
    client.post("/api/v1/auth/logout")
    assert client.post(
        "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
    ).status_code == 200
    return builder, reviewer, task


def _awaiting(client: TestClient, task_id: str) -> dict[str, Any]:
    task = client.get(f"/api/v1/tasks/{task_id}").json()
    assert task["status"] == "waiting_for_human"
    return task["awaiting"]


def test_a_team_round_waits_for_approval_before_its_review(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        builder, reviewer, task = _approval_team_task(client)

        assert client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).status_code == 202
        first = _finish(app, agent_id=builder["id"])
        thread_id = first["sessionId"]

        # Parked before the review: nothing queued, the thread closed, and
        # the task names the wait and who takes the held step.
        assert app.state.registry.take_commands(NODE, "node_token") == []
        assert client.get(f"/api/v1/threads/{thread_id}").json()["status"] == "completed"
        waiting = _awaiting(client, task["id"])
        assert waiting["kind"] == "approval"
        assert waiting["nextAgentId"] == reviewer["id"]
        first_question = waiting["questionId"]

        # A typed answer asks for changes: the builder works again, and the
        # round asks again before the review.
        changes = client.post(f"/api/v1/threads/{thread_id}/messages", json={
            "text": "Rename the helper before review.", "questionId": first_question,
        })
        assert changes.status_code == 202, changes.text
        _finish(app, agent_id=builder["id"])
        waiting = _awaiting(client, task["id"])
        assert waiting["kind"] == "approval"
        assert waiting["questionId"] != first_question

        # The superseded wait cannot be approved.
        stale = client.post(f"/api/v1/threads/{thread_id}/messages", json={
            "text": "Approved.", "questionId": first_question, "approve": True,
        })
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "question_superseded"

        approved = client.post(f"/api/v1/threads/{thread_id}/messages", json={
            "text": "Approved.", "questionId": waiting["questionId"], "approve": True,
        })
        assert approved.status_code == 202, approved.text
        _finish(app, agent_id=reviewer["id"])

        # The builder's evidence from before the approval still counts, so
        # the review closes the work instead of stopping on a missing report.
        settled = client.get(f"/api/v1/tasks/{task['id']}").json()
        assert settled["status"] in ("review", "done")
        runs = client.get(f"/api/v1/threads/{thread_id}").json()["agentRuns"]
        assert [run["logicalAgentId"] for run in runs] == [
            builder["id"], builder["id"], reviewer["id"],
        ]


def test_an_approval_must_name_an_approval_wait(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        builder, _reviewer, task = _approval_team_task(client)
        assert client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).status_code == 202
        thread_id = _finish(app, agent_id=builder["id"])["sessionId"]

        unnamed = client.post(f"/api/v1/threads/{thread_id}/messages", json={
            "text": "Approved.", "approve": True,
        })
        assert unnamed.status_code == 400
        assert unnamed.json()["detail"]["code"] == "approval_requires_question"


def test_a_team_without_approval_runs_straight_to_review(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        builder, reviewer, task = _approval_team_task(client)
        team_id = task["assignedTeamId"]
        assert client.patch(
            f"/api/v1/teams/{team_id}", json={"humanApproval": False}
        ).status_code == 200
        assert client.patch(
            f"/api/v1/teams/{team_id}", json={"humanApproval": "yes"}
        ).status_code == 400

        assert client.post(f"/api/v1/tasks/{task['id']}/runs", json={}).status_code == 202
        _finish(app, agent_id=builder["id"])
        _finish(app, agent_id=reviewer["id"])
        assert client.get(f"/api/v1/tasks/{task['id']}").json()["status"] in ("review", "done")
