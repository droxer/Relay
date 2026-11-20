from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from tempfile import TemporaryDirectory
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.core.computer_identity import computer_id
from user_ids import user_id

ALICE = user_id("alice")
OFFERS = "/api/v1/agents/default-offers"


@pytest.fixture
def alice(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[TestClient, str]]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        assert (
            client.post(
                "/api/v1/auth/bootstrap",
                json={"token": "admin_token", "username": "admin", "email": "admin@example.com", "password": "kestrel-vault-7719"},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/v1/admin/users",
                json={"userId": "alice", "username": "alice", "email": "alice@example.com", "password": "userpass", "displayName": "Alice"},
            ).status_code
            == 201
        )
        node = app.state.registry.register(
            {
                "sandboxId": "node_alice",
                "userId": ALICE,
                "workspaceId": "machine-alice",
                "token": "node_token",
                "workspacePath": "/workspace/alice",
                "nodeLocation": "user-device",
                "protocolVersion": 1,
                "supportedAgents": ["claude", "codex"],
                "capabilities": ["workspace-scope", "thread-workspaces"],
                "status": "ready",
            }
        )
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert client.post("/api/v1/auth/login", json={"username": "alice", "password": "userpass"}).status_code == 200
        yield client, computer_id(node)


def test_a_connected_computer_offers_its_ready_runtimes(alice) -> None:
    client, computer = alice

    response = client.get(OFFERS)

    assert response.status_code == 200
    [offer] = response.json()["offers"]
    assert offer["computerId"] == computer
    assert offer["executorKinds"] == ["claude", "codex"]
    assert offer["computerName"]
    # Asking is not answering: nothing exists until the person accepts.
    assert client.get("/api/v1/agents").json()["agents"] == []


def test_agent_roster_can_include_offers_without_repeating_inventory_reads(alice, monkeypatch) -> None:
    client, _ = alice
    offers = client.get(OFFERS).json()["offers"]
    registry = client.app.state.registry
    store = client.app.state.agent_store
    calls = []
    monitor, list_agents = registry.monitor_nodes, store.list_agents

    def read_inventory():
        calls.append("inventory")
        return monitor()

    def read_agents(**options):
        calls.append("agents")
        return list_agents(**options)

    monkeypatch.setattr(registry, "monitor_nodes", read_inventory)
    monkeypatch.setattr(store, "list_agents", read_agents)
    path = "/api/v1/agents?include=default-offers"
    assert client.get(path).json() == {"agents": [], "defaultAgentOffers": offers}
    assert calls == ["agents", "inventory"]
    assert client.get(f"{path}&view=summary").json() == {
        "agents": [], "defaultAgentOffers": offers, "view": "summary", "searchesInstructions": False,
    }
    assert calls == ["agents", "inventory"]
    assert TestClient(client.app).get(path).status_code == 401


def test_setup_view_returns_only_onboarding_candidates_and_offers(alice) -> None:
    client, computer = alice
    accepted = client.post(f"{OFFERS}/accept", json={"computerId": computer, "executorKinds": ["codex"]})
    assert accepted.status_code == 201, accepted.text
    assert client.post("/api/v1/agents", json={
        "computerId": computer, "executorKind": "codex", "displayName": "Another ready agent", "defaultRole": "reviewer",
    }).status_code == 201
    summary = client.get("/api/v1/agents?view=summary").json()["agents"]
    candidates = [agent for agent in summary if agent["availability"] in ("ready", "busy")]
    assert len(candidates) == 2
    path = "/api/v1/agents?include=default-offers&view=setup"
    response = client.get(path)
    assert response.status_code == 200
    data = response.json()
    assert data["view"] == "setup"
    assert data["defaultAgentOffers"] == client.get(OFFERS).json()["offers"]
    [candidate] = data["onboardingAgents"]
    assert candidate == {
        **{key: candidates[0][key] for key in ("id", "enabled", "executorKind", "availability")},
        "placements": [{key: placement[key] for key in ("daemonNodeId", "runtimeNodeId", "desiredState") if key in placement}
                       for placement in candidates[0]["placements"] if placement["desiredState"] == "active"],
    }
    assert "agents" not in data
    assert client.get(path, headers={"If-None-Match": response.headers["etag"]}).status_code == 304
    assert TestClient(client.app).get(path).status_code == 401


def test_accept_mixed_answer_creates_only_unanswered_runtimes(alice) -> None:
    client, computer = alice
    assert (
        client.post(f"{OFFERS}/decline", json={"computerId": computer, "executorKinds": ["claude"]}).status_code == 200
    )

    response = client.post(f"{OFFERS}/accept", json={"computerId": computer, "executorKinds": ["claude", "codex"]})

    assert response.status_code == 201
    assert [agent["executorKind"] for agent in response.json()["agents"]] == ["codex"]
    assert client.get(OFFERS).json()["offers"] == []
    combined = client.get("/api/v1/agents?include=default-offers").json()
    assert combined["defaultAgentOffers"] == []
    assert [agent["executorKind"] for agent in combined["agents"]] == ["codex"]


def test_concurrent_accepts_create_one_default(alice) -> None:
    client, computer = alice
    ready = Barrier(2)

    def accept():
        ready.wait(timeout=5)
        return client.post(f"{OFFERS}/accept", json={"computerId": computer, "executorKinds": ["claude"]})

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: accept(), range(2)))

    assert [response.status_code for response in responses] == [201, 201]
    assert sum(len(response.json()["agents"]) for response in responses) == 1


def test_accepting_creates_placed_default_agents_and_closes_the_offer(alice) -> None:
    client, computer = alice

    response = client.post(f"{OFFERS}/accept", json={"computerId": computer, "executorKinds": ["codex"]})

    assert response.status_code == 201
    [agent] = response.json()["agents"]
    assert (agent["displayName"], agent["executorKind"]) == ("Codex", "codex")
    assert client.app.state.agent_placement_store.list_placements(agent_id=agent["id"])
    assert client.get(OFFERS).json()["offers"][0]["executorKinds"] == ["claude"]
    # A second click creates nothing more.
    again = client.post(f"{OFFERS}/accept", json={"computerId": computer, "executorKinds": ["codex"]})
    assert again.status_code == 201
    assert again.json()["agents"] == []


def test_declining_is_remembered(alice) -> None:
    client, computer = alice

    response = client.post(
        f"{OFFERS}/decline",
        json={"computerId": computer, "executorKinds": ["claude", "codex"]},
    )

    assert response.status_code == 200
    assert client.get(OFFERS).json()["offers"] == []
    assert client.get("/api/v1/agents").json()["agents"] == []
    declined = client.get("/api/v1/auth/me").json()["user"]["onboarding"]
    assert declined["declinedDefaultAgents"] == [
        {"computerId": computer, "executorKind": "claude"},
        {"computerId": computer, "executorKind": "codex"},
    ]


def test_a_deleted_agent_answers_the_offer(alice) -> None:
    client, computer = alice
    [agent] = client.post(f"{OFFERS}/accept", json={"computerId": computer, "executorKinds": ["claude"]}).json()[
        "agents"
    ]

    assert client.delete(f"/api/v1/agents/{agent['id']}").status_code == 200

    assert client.get(OFFERS).json()["offers"][0]["executorKinds"] == ["codex"]


@pytest.mark.parametrize(
    "body, status",
    [
        ({"executorKinds": ["claude"]}, 400),
        ({"computerId": "x", "executorKinds": []}, 400),
        ({"computerId": "x", "executorKinds": ["claude"]}, 404),
        ({"computerId": "COMPUTER", "executorKinds": ["kimi"]}, 400),
        ({"computerId": "COMPUTER", "executorKinds": ["nope"]}, 400),
    ],
)
def test_accept_rejects_bad_answers(alice, body, status) -> None:
    client, computer = alice
    if body.get("computerId") == "COMPUTER":
        body = {**body, "computerId": computer}

    assert client.post(f"{OFFERS}/accept", json=body).status_code == status
    assert client.get("/api/v1/agents").json()["agents"] == []


def test_offers_need_a_signed_in_user(alice) -> None:
    client, _ = alice
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert client.get(OFFERS).status_code == 401


@pytest.mark.parametrize("stale_session_cache", [False, True])
def test_stale_accept_respects_saved_decline(alice, stale_session_cache) -> None:
    from relay.security.auth_cache import SESSION_ACCOUNTS
    from relay.security.credentials import hash_session_token

    client, computer = alice
    assert client.get(OFFERS).status_code == 200
    token_hash = hash_session_token(client.cookies["relay_session"])
    old_account = SESSION_ACCOUNTS.get(token_hash)
    body = {"computerId": computer, "executorKinds": ["claude"]}
    assert client.post(f"{OFFERS}/decline", json=body).status_code == 200
    if stale_session_cache:
        assert old_account is not None
        SESSION_ACCOUNTS.put(token_hash, old_account)

    response = client.post(f"{OFFERS}/accept", json=body)

    assert response.status_code == 201
    assert response.json()["agents"] == []
    assert client.get("/api/v1/agents").json()["agents"] == []


def test_default_agent_saves_the_reported_runtime_default_model(alice) -> None:
    client, computer = alice
    registry = client.app.state.registry
    registry.register({
        "sandboxId": "node_alice", "userId": ALICE, "workspaceId": "machine-alice",
        "token": "node_token", "protocolVersion": 1, "supportedAgents": ["claude", "codex"],
        "capabilities": ["workspace-scope", "thread-workspaces", "agent-model"], "status": "ready",
        "agentDefaultModels": {"codex": "configured-model", "claude": "bad model", "unknown": "other"},
        "agentModels": {"codex": ["first-catalog-model", "configured-model"]},
    })
    response = client.post(f"{OFFERS}/accept", json={"computerId": computer, "executorKinds": ["codex"]})
    assert response.status_code == 201
    [agent] = response.json()["agents"]
    assert agent["modelPolicy"] == {"model": "configured-model"}
    assert client.get("/api/v1/agents").json()["agents"][0]["modelPolicy"] == agent["modelPolicy"]
    assert registry.monitor_nodes()[0]["agentDefaultModels"] == {"codex": "configured-model"}
