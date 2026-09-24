"""A started thread may hand its next round to anyone on its computer.

The thread is pinned to one computer and every agent there shares that
workspace, so the round's target — a single agent or a whole team — is free to
change as long as it stays on that machine.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from tempfile import TemporaryDirectory
from typing import Any

from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core.computer_identity import computer_id
from relay.services.node_agents import sync_node_agents


def _bootstrap_admin(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
    )
    assert response.status_code == 200, response.text


def _node(app, sandbox_id: str) -> dict[str, Any]:
    return app.state.registry.register(
        {
            "sandboxId": sandbox_id,
            "employeeId": "admin",
            "token": f"token_{sandbox_id}",
            "workspacePath": f"/workspace/{sandbox_id}",
            "protocolVersion": 1,
            "supportedAgents": ["codex", "claude"],
            "capabilities": ["thread-workspaces", "work-results"],
            "status": "ready",
        }
    )


def _agent(app, node: dict[str, Any], name: str, executor: str) -> dict[str, Any]:
    return app.state.agent_store.create_agent(
        "admin",
        {
            "displayName": name,
            "executorKind": executor,
            "defaultRole": "implementer",
            "computerId": computer_id(node),
        },
    )


def _team(app, name: str, lead: dict[str, Any], *members: dict[str, Any]) -> dict[str, Any]:
    return app.state.team_store.create_team(
        "admin",
        {
            "name": name,
            "leadAgentId": lead["id"],
            "memberAgentIds": [lead["id"], *(member["id"] for member in members)],
        },
    )


def _thread(app, node: dict[str, Any], owner: dict[str, Any], **fields: Any) -> dict[str, Any]:
    return app.state.session_store.create_session(
        {
            "daemonNodeId": node["id"],
            "workspacePath": node["workspacePath"],
            "ownerEmployeeId": "admin",
            "ownerAgentId": owner["id"],
            "taskGoal": "Keep one room",
            **fields,
        }
    )


def _last_round_agent_ids(app, session_id: str) -> set[str]:
    rounds = app.state.session_store.get_session(session_id)["collaborationRounds"]
    return {assignment["agentId"] for assignment in rounds[-1]["assignments"]}


@contextmanager
def _world(monkeypatch) -> Iterator[tuple[Any, TestClient, dict[str, Any], dict[str, Any]]]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap_admin(client)
        here = _node(app, "node_here")
        there = _node(app, "node_there")
        yield app, client, here, there


def _sync(app, *nodes: dict[str, Any]) -> None:
    for node in nodes:
        sync_node_agents(app.state, node)


def test_agent_thread_hands_a_round_to_a_team_on_its_computer(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        solo = _agent(app, here, "Solo", "codex")
        lead = _agent(app, here, "Lead", "claude")
        helper = _agent(app, here, "Helper", "codex")
        _sync(app, here, there)
        team = _team(app, "Crew", lead, helper)
        session = _thread(app, here, solo)

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={"text": "team, take it", "addressTeamId": team["id"]},
        )

        assert response.status_code == 202, response.text
        assert _last_round_agent_ids(app, session["id"]) == {lead["id"], helper["id"]}
        after = app.state.session_store.get_session(session["id"])
        assert {lead["id"], helper["id"]} <= set(after["participantAgentIds"])


def test_team_round_is_refused_when_a_member_lives_on_another_computer(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        solo = _agent(app, here, "Solo", "codex")
        lead = _agent(app, here, "Lead", "claude")
        far = _agent(app, there, "Far", "codex")
        _sync(app, here, there)
        team = _team(app, "Split", lead, far)
        session = _thread(app, here, solo)

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={"text": "team, take it", "addressTeamId": team["id"]},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "agent_not_on_thread_node"


def test_team_thread_hands_a_round_to_an_agent_outside_the_team(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead", "claude")
        helper = _agent(app, here, "Helper", "codex")
        outsider = _agent(app, here, "Outsider", "codex")
        _sync(app, here, there)
        team = _team(app, "Crew", lead, helper)
        session = _thread(app, here, lead, teamId=team["id"])

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={"text": "outsider, weigh in", "addressAgentIds": [outsider["id"]]},
        )

        assert response.status_code == 202, response.text
        assert _last_round_agent_ids(app, session["id"]) == {outsider["id"]}
        # The thread keeps its team; only this round went elsewhere.
        assert app.state.session_store.get_session(session["id"])["teamId"] == team["id"]


def test_team_thread_refuses_an_agent_on_another_computer(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead", "claude")
        far = _agent(app, there, "Far", "codex")
        _sync(app, here, there)
        team = _team(app, "Crew", lead)
        session = _thread(app, here, lead, teamId=team["id"])

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={"text": "far, weigh in", "addressAgentIds": [far["id"]]},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "agent_not_on_thread_node"


def test_team_thread_hands_a_round_to_another_team_on_its_computer(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead", "claude")
        other_lead = _agent(app, here, "Other lead", "codex")
        _sync(app, here, there)
        team = _team(app, "Crew", lead)
        other = _team(app, "Other crew", other_lead)
        session = _thread(app, here, lead, teamId=team["id"])

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={"text": "other crew, go", "addressTeamId": other["id"]},
        )

        assert response.status_code == 202, response.text
        assert _last_round_agent_ids(app, session["id"]) == {other_lead["id"]}


def test_a_message_cannot_address_a_team_and_agents_at_once(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        solo = _agent(app, here, "Solo", "codex")
        lead = _agent(app, here, "Lead", "claude")
        _sync(app, here, there)
        team = _team(app, "Crew", lead)
        session = _thread(app, here, solo)

        response = client.post(
            f"/api/v1/threads/{session['id']}/messages",
            json={
                "text": "both",
                "addressTeamId": team["id"],
                "addressAgentIds": [solo["id"]],
            },
        )

        assert response.status_code == 400
