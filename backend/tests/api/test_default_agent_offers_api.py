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
                json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/api/v1/admin/users",
                json={"userId": "alice", "username": "alice", "password": "userpass", "displayName": "Alice"},
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
                "capabilities": ["thread-workspaces"],
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


def test_accept_mixed_answer_creates_only_unanswered_runtimes(alice) -> None:
    client, computer = alice
    assert (
        client.post(f"{OFFERS}/decline", json={"computerId": computer, "executorKinds": ["claude"]}).status_code == 200
    )

    response = client.post(f"{OFFERS}/accept", json={"computerId": computer, "executorKinds": ["claude", "codex"]})

    assert response.status_code == 201
    assert [agent["executorKind"] for agent in response.json()["agents"]] == ["codex"]
    assert client.get(OFFERS).json()["offers"] == []


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
