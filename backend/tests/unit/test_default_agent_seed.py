from pathlib import Path
from types import SimpleNamespace

import pytest

from relay.core.computer_identity import computer_id
from relay.migrations_runtime.default_agents import (
    seed_default_agents,
    seed_default_agents_at_startup,
)
from store_fixtures import make_agent_placement_store, make_agent_store


def _node(**overrides):
    return {
        "id": "node-1",
        "userId": "alice",
        "workspaceId": "machine-a",
        "agents": {"claude": "ready", "codex": "ready", "pi": "unavailable"},
        "online": False,
        "status": "stopped",
        "createdAt": "2020-01-01T00:00:00Z",
        **overrides,
    }


def _seed(tmp_path: Path, nodes, *, users=None, agents=None):
    agents = agents or make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    auth = (
        SimpleNamespace(list_users=lambda: [{"id": user} for user in users], list_accounts=lambda: [])
        if users is not None
        else None
    )
    created = seed_default_agents(
        agent_store=agents,
        agent_placement_store=placements,
        registry=SimpleNamespace(monitor_nodes=lambda: nodes),
        auth_store=auth,
    )
    return created, agents, placements


def test_existing_computer_gets_a_default_agent_per_reported_runtime(
    tmp_path: Path,
) -> None:
    node = _node()

    created, agents, placements = _seed(tmp_path, [node])

    assert created == 2
    seeded = agents.list_agents(supervisor_user_id="alice")
    assert sorted(a["executorKind"] for a in seeded) == ["claude", "codex"]
    assert {a["computerId"] for a in seeded} == {computer_id(node)}
    for agent in seeded:
        [placement] = placements.list_placements(agent_id=agent["id"])
        assert placement["daemonNodeId"] == "node-1"


def test_seed_is_idempotent(tmp_path: Path) -> None:
    created, agents, _ = _seed(tmp_path, [_node()])
    again, _, _ = _seed(tmp_path, [_node()], agents=agents)
    assert (created, again) == (2, 0)
    assert len(agents.list_agents(supervisor_user_id="alice")) == 2


def test_one_computer_with_several_node_records_is_seeded_once(
    tmp_path: Path,
) -> None:
    newest = _node(id="node-new")
    older = _node(id="node-old")

    created, agents, placements = _seed(tmp_path, [newest, older])

    assert created == 2
    for agent in agents.list_agents(supervisor_user_id="alice"):
        [placement] = placements.list_placements(agent_id=agent["id"])
        assert placement["daemonNodeId"] == "node-new"


def test_seed_skips_deleted_agents_retired_nodes_and_departed_users(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    deleted = agents.create_agent(
        "alice",
        {
            "displayName": "Ada",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": computer_id(_node()),
        },
    )
    agents.delete_agent(deleted["id"])
    nodes = [
        _node(agents={"claude": "ready"}),
        _node(id="node-r", workspaceId="machine-r", retiredAt="2026-10-01T00:00:00Z"),
        _node(id="node-b", userId="bob", workspaceId="machine-b"),
    ]

    created, _, _ = _seed(tmp_path, nodes, users=["alice"], agents=agents)

    assert created == 0
    assert agents.list_agents(supervisor_user_id="bob") == []


def _startup_seed(agents, placements, nodes):
    seed_default_agents_at_startup(
        engine=agents.engine,
        agent_store=agents,
        agent_placement_store=placements,
        registry=SimpleNamespace(monitor_nodes=lambda: nodes),
    )


def test_startup_seed_runs_once_per_installation(tmp_path: Path) -> None:
    """After the first boot a connecting computer is asked, so a restart must
    not create its defaults behind the person's back."""
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)

    _startup_seed(agents, placements, [_node(agents={"claude": "ready"})])
    _startup_seed(
        agents,
        placements,
        [_node(id="node-b", workspaceId="machine-b", agents={"codex": "ready"})],
    )

    assert [a["executorKind"] for a in agents.list_agents(supervisor_user_id="alice")] == ["claude"]


def test_a_failed_startup_seed_is_retried_and_never_raises(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)

    def broken():
        raise RuntimeError("database unavailable")

    seed_default_agents_at_startup(
        engine=agents.engine,
        agent_store=agents,
        agent_placement_store=placements,
        registry=SimpleNamespace(monitor_nodes=broken),
    )
    _startup_seed(agents, placements, [_node(agents={"claude": "ready"})])

    assert len(agents.list_agents(supervisor_user_id="alice")) == 1


def test_interrupted_seed_rolls_back_and_retries(tmp_path: Path, monkeypatch) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)

    def interrupted(*args, **kwargs):
        raise KeyboardInterrupt("process interrupted after agent creation")

    with monkeypatch.context() as patch:
        patch.setattr(placements, "create_placement", interrupted)
        with pytest.raises(KeyboardInterrupt):
            _startup_seed(agents, placements, [_node()])

    assert agents.list_agents(supervisor_user_id="alice") == []
    _startup_seed(agents, placements, [_node()])
    seeded = agents.list_agents(supervisor_user_id="alice")
    assert len(seeded) == 2
    assert all(placements.list_placements(agent_id=agent["id"]) for agent in seeded)


def test_failed_seed_retry_excludes_new_computers(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)

    def broken():
        raise RuntimeError("database unavailable")

    seed_default_agents_at_startup(
        engine=agents.engine,
        agent_store=agents,
        agent_placement_store=placements,
        registry=SimpleNamespace(monitor_nodes=broken),
    )
    _startup_seed(
        agents,
        placements,
        [
            _node(agents={"claude": "ready"}),
            _node(id="node-new", workspaceId="machine-new", createdAt="2999-01-01T00:00:00Z"),
        ],
    )

    seeded = agents.list_agents(supervisor_user_id="alice")
    assert len(seeded) == 1
    assert seeded[0]["computerId"] == computer_id(_node())


def test_seed_honors_declines(tmp_path: Path) -> None:
    from store_fixtures import make_auth_store

    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    auth = make_auth_store(tmp_path)
    account = auth.create_account("alice", "kestrel-vault-7719", user_id="alice")
    node = _node(userId=account["userId"])
    auth.update_user_preferences(
        account["id"],
        onboarding={
            "declineDefaultAgents": [
                {"computerId": computer_id(node), "executorKind": "claude"},
            ]
        },
    )

    seed_default_agents_at_startup(
        engine=agents.engine,
        agent_store=agents,
        agent_placement_store=placements,
        registry=SimpleNamespace(monitor_nodes=lambda: [node]),
        auth_store=auth,
    )

    assert [a["executorKind"] for a in agents.list_agents(supervisor_user_id=account["userId"])] == ["codex"]
