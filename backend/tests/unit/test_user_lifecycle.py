from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from relay.persistence.agent.placements import DatabaseAgentPlacementStore
from relay.persistence.agent.store import DatabaseAgentStore
from relay.persistence.daemon.store import DatabaseDaemonStore
from relay.persistence.team.store import DatabaseTeamStore
from relay.security.auth import DatabaseAccountAuthStore
from relay.accounts.user_lifecycle import cascade_engine, soft_delete_user


class RaisingManagedNodeStore:
    """Stands in for the managed-node store failing mid-cascade."""

    def __init__(self, error: Exception | None = None):
        self.error = error
        self.nodes: list[dict] = []

    def list_nodes(self) -> list[dict]:
        return self.nodes

    def update_node(self, node_id: str, patch: dict) -> dict:
        if self.error:
            raise self.error
        node = next(node for node in self.nodes if node["id"] == node_id)
        node.update(patch)
        return node


def add_managed_node(store: RaisingManagedNodeStore, user_id: str) -> None:
    store.nodes.append({"id": "managed_a", "userId": user_id})


def build_context(tmp_path: Path, managed_node_store: object) -> SimpleNamespace:
    url = f"sqlite:///{tmp_path}/relay.db"
    auth_store = DatabaseAccountAuthStore(url, create_schema=True)
    agent_store = DatabaseAgentStore(url)
    placement_store = DatabaseAgentPlacementStore(url)
    team_store = DatabaseTeamStore(url)
    daemon_store = DatabaseDaemonStore(url)
    registry = SimpleNamespace(
        daemon_store=daemon_store,
        sandboxes={},
        unassign_user_everywhere=lambda user_id: [],
        get=lambda node_id: None,
        fence_managed_node=lambda node_id: None,
    )
    return SimpleNamespace(
        auth_store=auth_store,
        agent_store=agent_store,
        agent_placement_store=placement_store,
        team_store=team_store,
        registry=registry,
        managed_node_store=managed_node_store,
    )


def seed_user(ctx: SimpleNamespace) -> tuple[str, str]:
    account = ctx.auth_store.create_account(
        "alice", "userpass", user_id="alice", display_name="Alice"
    )
    user_id = account["userId"]
    agent = ctx.agent_store.create_agent(
        user_id,
        {
            "displayName": "Planner",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    return user_id, agent["id"]


def test_cascade_stores_share_one_engine(tmp_path: Path) -> None:
    ctx = build_context(tmp_path, RaisingManagedNodeStore())

    assert cascade_engine(ctx) is ctx.auth_store.engine


def test_successful_cascade_deletes_user_and_agents(tmp_path: Path) -> None:
    ctx = build_context(tmp_path, RaisingManagedNodeStore())
    user_id, agent_id = seed_user(ctx)

    result = soft_delete_user(ctx, user_id)

    assert result["deletedAgents"] == [agent_id]
    assert ctx.auth_store.list_users() == []
    assert ctx.agent_store.list_agents(supervisor_user_id=user_id) == []


def test_failure_midway_leaves_the_user_and_agents_intact(tmp_path: Path) -> None:
    """The whole cascade is one transaction.

    Without it, the user was already marked deleted and their agents gone
    by the time the managed-node step failed, leaving no way to finish or undo.
    """
    ctx = build_context(
        tmp_path, RaisingManagedNodeStore(RuntimeError("provider down"))
    )
    user_id, agent_id = seed_user(ctx)
    add_managed_node(ctx.managed_node_store, user_id)

    with pytest.raises(RuntimeError, match="provider down"):
        soft_delete_user(ctx, user_id)

    assert [item["id"] for item in ctx.auth_store.list_users()] == [user_id]
    live_agents = ctx.agent_store.list_agents(supervisor_user_id=user_id)
    assert [agent["id"] for agent in live_agents] == [agent_id]


def test_failure_restores_in_memory_registry_nodes(tmp_path: Path) -> None:
    ctx = build_context(
        tmp_path, RaisingManagedNodeStore(RuntimeError("provider down"))
    )
    user_id, _ = seed_user(ctx)
    add_managed_node(ctx.managed_node_store, user_id)
    ctx.registry.sandboxes["node_a"] = {"id": "node_a", "userId": user_id}

    def drop_user(_user_id: str) -> list[str]:
        ctx.registry.sandboxes["node_a"] = {"id": "node_a"}
        return ["node_a"]

    ctx.registry.unassign_user_everywhere = drop_user

    with pytest.raises(RuntimeError, match="provider down"):
        soft_delete_user(ctx, user_id)

    assert ctx.registry.sandboxes["node_a"]["userId"] == user_id


def test_failure_does_not_erase_an_unrelated_registry_update(tmp_path: Path) -> None:
    ctx = build_context(tmp_path, RaisingManagedNodeStore())
    user_id, _ = seed_user(ctx)
    ctx.registry.sandboxes["node_a"] = {"id": "node_a", "userId": user_id}

    add_managed_node(ctx.managed_node_store, user_id)

    def fail_after_unrelated_update(node_id: str, patch: dict) -> dict:
        ctx.registry.sandboxes["node_b"] = {"id": "node_b", "status": "ready"}
        raise RuntimeError("provider down")

    ctx.managed_node_store.update_node = fail_after_unrelated_update

    with pytest.raises(RuntimeError, match="provider down"):
        soft_delete_user(ctx, user_id)

    assert ctx.registry.sandboxes["node_b"]["status"] == "ready"


def test_file_backed_stores_have_no_shared_engine(tmp_path: Path) -> None:
    ctx = SimpleNamespace(
        auth_store=SimpleNamespace(),
        agent_store=SimpleNamespace(),
        agent_placement_store=SimpleNamespace(),
        team_store=SimpleNamespace(),
        registry=SimpleNamespace(daemon_store=SimpleNamespace()),
    )

    assert cascade_engine(ctx) is None
