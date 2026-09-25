"""A team lives on one computer.

Team setup picks the computer first and the roster comes from the agents on
it, so a team can always take a thread on that machine. The backend is the
authority: a roster that spans computers is refused, and the team records the
computer it was set up on.
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


def _node(app, sandbox_id: str, employee_id: str = "admin") -> dict[str, Any]:
    return app.state.registry.register(
        {
            "sandboxId": sandbox_id,
            "employeeId": employee_id,
            "token": f"token_{sandbox_id}",
            "workspacePath": f"/workspace/{sandbox_id}",
            "protocolVersion": 1,
            "supportedAgents": ["codex", "claude"],
            "capabilities": ["thread-workspaces"],
            "status": "ready",
        }
    )


def _agent(app, node: dict[str, Any], name: str) -> dict[str, Any]:
    return app.state.agent_store.create_agent(
        "admin",
        {
            "displayName": name,
            "executorKind": "codex",
            "defaultRole": "implementer",
            "computerId": computer_id(node),
        },
    )


@contextmanager
def _world(monkeypatch) -> Iterator[tuple[Any, TestClient, dict[str, Any], dict[str, Any]]]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        response = client.post(
            "/api/v1/auth/bootstrap",
            json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
        )
        assert response.status_code == 200, response.text
        here = _node(app, "node_here")
        there = _node(app, "node_there")
        yield app, client, here, there


def _sync(app, *nodes: dict[str, Any]) -> None:
    for node in nodes:
        sync_node_agents(app.state, node)


def _create(client: TestClient, lead: dict[str, Any], *members: dict[str, Any], **extra: Any):
    return client.post(
        "/api/v1/teams",
        json={
            "name": extra.pop("name", "Crew"),
            "leadAgentId": lead["id"],
            "memberAgentIds": [lead["id"], *(member["id"] for member in members)],
            **extra,
        },
    )


def test_team_created_on_a_computer_records_it(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead")
        helper = _agent(app, here, "Helper")
        _sync(app, here, there)

        response = _create(client, lead, helper, computerId=computer_id(here))

        assert response.status_code == 201, response.text
        assert response.json()["team"]["computerId"] == computer_id(here)


def test_team_member_on_another_computer_is_refused(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead")
        far = _agent(app, there, "Far")
        _sync(app, here, there)

        response = _create(client, lead, far, computerId=computer_id(here))

        assert response.status_code == 400
        assert response.json()["detail"] == "team_member_computer_mismatch"


def test_team_without_a_named_computer_takes_its_roster_computer(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, there, "Lead")
        helper = _agent(app, there, "Helper")
        _sync(app, here, there)

        response = _create(client, lead, helper)

        assert response.status_code == 201, response.text
        assert response.json()["team"]["computerId"] == computer_id(there)


def test_team_roster_spanning_computers_is_refused_without_a_named_computer(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead")
        far = _agent(app, there, "Far")
        _sync(app, here, there)

        response = _create(client, lead, far)

        assert response.status_code == 400
        assert response.json()["detail"] == "team_member_computer_mismatch"


def test_team_computer_must_belong_to_the_owner(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead")
        _sync(app, here, there)
        foreign = _node(app, "node_foreign", employee_id="someone-else")

        response = _create(client, lead, computerId=computer_id(foreign))

        assert response.status_code == 400
        assert response.json()["detail"] == "team_computer_forbidden"


def test_adding_a_member_from_another_computer_is_refused(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead")
        far = _agent(app, there, "Far")
        _sync(app, here, there)
        team = _create(client, lead, computerId=computer_id(here)).json()["team"]

        response = client.patch(
            f"/api/v1/teams/{team['id']}",
            json={"memberAgentIds": [lead["id"], far["id"]]},
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "team_member_computer_mismatch"


def test_moving_a_team_to_the_computer_hosting_its_roster(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead")
        mover = _agent(app, there, "Mover")
        _sync(app, here, there)
        team = _create(client, lead, computerId=computer_id(here)).json()["team"]

        response = client.patch(
            f"/api/v1/teams/{team['id']}",
            json={
                "computerId": computer_id(there),
                "leadAgentId": mover["id"],
                "memberAgentIds": [mover["id"]],
            },
        )

        assert response.status_code == 200, response.text
        assert response.json()["team"]["computerId"] == computer_id(there)


def test_renaming_a_legacy_split_team_still_works(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead")
        far = _agent(app, there, "Far")
        _sync(app, here, there)
        legacy = app.state.team_store.create_team(
            "admin",
            {"name": "Legacy", "leadAgentId": lead["id"], "memberAgentIds": [lead["id"], far["id"]]},
        )

        response = client.patch(f"/api/v1/teams/{legacy['id']}", json={"name": "Renamed"})

        assert response.status_code == 200, response.text
        assert response.json()["team"]["name"] == "Renamed"


def test_saving_a_legacy_split_team_with_its_unchanged_roster_still_works(monkeypatch) -> None:
    with _world(monkeypatch) as (app, client, here, there):
        lead = _agent(app, here, "Lead")
        far = _agent(app, there, "Far")
        _sync(app, here, there)
        roster = [lead["id"], far["id"]]
        legacy = app.state.team_store.create_team(
            "admin",
            {"name": "Legacy", "leadAgentId": lead["id"], "memberAgentIds": roster},
        )

        # The web resends the stored roster with every save (rename, one
        # member's contract); that is not a roster change.
        response = client.patch(
            f"/api/v1/teams/{legacy['id']}",
            json={"name": "Renamed", "leadAgentId": lead["id"], "memberAgentIds": list(reversed(roster))},
        )

        assert response.status_code == 200, response.text
