from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from store_fixtures import make_agent_placement_store
from store_fixtures import make_agent_store
from store_fixtures import make_session_store
from relay.persistence.events import relay_event
from relay.agents.routing import AgentRoutingError, resolve_agent_assignments


def node(
    node_id: str,
    executor: str,
    *,
    workspace: str = "/shared/workspace",
    workspace_id: str | None = None,
) -> dict:
    return {
        "id": node_id,
        "online": True,
        "stale": False,
        "status": "ready",
        "agents": {executor: "ready"},
        "workspacePath": workspace,
        **({"workspaceId": workspace_id} if workspace_id else {}),
        "activeRuns": [],
        "maxConcurrentRuns": 1,
    }


def test_rejects_collaboration_across_nodes_even_with_shared_workspace(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    researcher = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
            "instructions": "Compare sources before answering.",
        },
    )
    builder = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(
        researcher, "node_a", {"workspacePolicy": {"kind": "shared-path"}}
    )
    placements.create_placement(
        builder, "node_b", {"workspacePolicy": {"kind": "shared-path"}}
    )

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [
                {"agentId": researcher["id"]},
                {"agentId": builder["id"]},
            ],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[
                node("node_a", "claude", workspace_id="repo:relay"),
                node("node_b", "codex", workspace_id="repo:relay"),
            ],
        )

    assert error.value.code == "workspace_unavailable"
    # "no eligible runtime placement" reads like the agent is broken. The real
    # cause is that the round spans two computers, and only the message can
    # say so.
    assert "Builder" in str(error.value)
    assert "computer" in str(error.value)


def test_agents_on_same_computer_resolve_together(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    researcher = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    builder = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(researcher, "node_a")
    placements.create_placement(builder, "node_a")
    computer = {
        **node("node_a", "claude"),
        "agents": {"claude": "ready", "codex": "ready"},
        "maxConcurrentRuns": 2,
    }

    resolved = resolve_agent_assignments(
        [
            {"agentId": researcher["id"]},
            {"agentId": builder["id"]},
        ],
        user_id="alice",
        is_admin=False,
        agent_store=agents,
        placement_store=placements,
        daemon_nodes=[computer],
    )

    assert [item["daemonNodeId"] for item in resolved] == ["node_a", "node_a"]


def test_user_cannot_route_another_users_agent(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_a")

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="bob",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[node("node_a", "claude")],
        )

    assert error.value.code == "agent_forbidden"


def test_managed_capacity_does_not_replace_a_healthy_local_placement(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    local_placement = placements.create_placement(agent, "node_local")
    local_node = {**node("node_local", "codex"), "userId": "alice"}
    managed_node = {
        **node("node_managed", "codex"),
        "userId": "alice",
        "managedNodeId": "managed_alice",
    }

    [resolved] = resolve_agent_assignments(
        [{"agentId": agent["id"]}],
        user_id="alice",
        is_admin=False,
        agent_store=agents,
        placement_store=placements,
        daemon_nodes=[local_node, managed_node],
    )

    assert resolved["daemonNodeId"] == "node_local"
    active = placements.list_placements(agent_id=agent["id"])
    assert [placement["id"] for placement in active] == [local_placement["id"]]


def test_managed_capacity_does_not_move_an_offline_agent_to_another_computer(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    original = placements.create_placement(
        agent, "runtime_a", {"managedNodeId": "computer_a"}
    )
    offline = {
        **node("runtime_a", "codex"),
        "userId": "alice",
        "managedNodeId": "computer_a",
        "online": False,
        "stale": True,
        "status": "stopped",
    }
    other = {
        **node("runtime_b", "codex"),
        "userId": "alice",
        "managedNodeId": "computer_b",
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[offline, other],
        )

    assert error.value.code == "node_offline"
    [preserved] = placements.list_placements(agent_id=agent["id"])
    assert preserved["id"] == original["id"]
    assert preserved["daemonNodeId"] == "runtime_a"


def test_legacy_nonempty_policy_blocks_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Restricted",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_a")
    get_agent = agents.get_agent

    def legacy_agent(agent_id: str) -> dict | None:
        current = get_agent(agent_id)
        return (
            {**current, "toolPolicy": {"allowedTools": ["read"]}} if current else None
        )

    monkeypatch.setattr(agents, "get_agent", legacy_agent)

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[node("node_a", "codex")],
        )

    assert error.value.code == "agent_policy_unsupported"


def test_canonical_workspace_id_does_not_override_node_scope(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    researcher = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    builder = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(
        researcher, "node_a", {"workspacePolicy": {"kind": "shared-path"}}
    )
    placements.create_placement(
        builder, "node_b", {"workspacePolicy": {"kind": "shared-path"}}
    )

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": researcher["id"]}, {"agentId": builder["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[
                node(
                    "node_a",
                    "claude",
                    workspace="/mnt/a/relay",
                    workspace_id="repo:relay",
                ),
                node(
                    "node_b",
                    "codex",
                    workspace="D:/work/relay",
                    workspace_id="repo:relay",
                ),
            ],
        )

    assert error.value.code == "workspace_unavailable"


def test_node_affine_placements_reject_cross_node_workflow(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    researcher = agents.create_agent(
        "alice",
        {
            "displayName": "Researcher",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    builder = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(researcher, "node_a")
    placements.create_placement(builder, "node_b")

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": researcher["id"]}, {"agentId": builder["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[
                node("node_a", "claude", workspace_id="repo:relay"),
                node("node_b", "codex", workspace_id="repo:relay"),
            ],
        )

    assert error.value.code == "workspace_unavailable"


def test_different_workspace_ids_reject_cross_node_workflow(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    first = agents.create_agent(
        "alice",
        {
            "displayName": "First",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    second = agents.create_agent(
        "alice",
        {
            "displayName": "Second",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(first, "node_a")
    placements.create_placement(second, "node_b")

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": first["id"]}, {"agentId": second["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[
                node("node_a", "claude", workspace_id="repo:first"),
                node("node_b", "codex", workspace_id="repo:second"),
            ],
        )

    assert error.value.code == "workspace_unavailable"


def test_node_affine_session_rejects_followup_on_different_node(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    first = agents.create_agent(
        "alice",
        {
            "displayName": "First",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    second = agents.create_agent(
        "alice",
        {
            "displayName": "Second",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    first_placement = placements.create_placement(first, "node_a")
    placements.create_placement(second, "node_b")
    session = {
        "id": "ses_existing",
        "workspacePath": "/workspace/alice",
        "agentRuns": [
            {
                "logicalAgentId": first["id"],
                "placementId": first_placement["id"],
                "daemonNodeId": "node_a",
            }
        ],
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": second["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[
                node("node_a", "claude", workspace_id="repo:relay"),
                node("node_b", "codex", workspace_id="repo:relay"),
            ],
            session=session,
        )

    assert error.value.code == "workspace_unavailable"


def test_session_without_prior_run_does_not_invent_node_affinity(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_a")

    resolved = resolve_agent_assignments(
        [{"agentId": agent["id"]}],
        user_id="alice",
        is_admin=False,
        agent_store=agents,
        placement_store=placements,
        daemon_nodes=[
            node(
                "node_a",
                "codex",
                workspace="/host/alice",
                workspace_id="user:alice:home",
            )
        ],
        session={
            "id": "ses_fresh",
            "workspacePath": "/workspace",
            "agentRuns": [],
        },
    )

    assert resolved[0]["daemonNodeId"] == "node_a"


def test_managed_runtime_replacement_keeps_existing_session_affinity(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placement = placements.create_placement(agent, "node_old")
    session = {
        "id": "ses_existing",
        "daemonNodeId": "node_old",
        "workspacePath": "/workspace",
        "agentRuns": [
            {
                "logicalAgentId": agent["id"],
                "placementId": placement["id"],
                "daemonNodeId": "node_old",
                "workspaceIdentity": {
                    "kind": "id",
                    "value": "managed:computer_one",
                },
            }
        ],
    }
    placements.rebind_placement(placement["id"], "node_new")

    resolved = resolve_agent_assignments(
        [{"agentId": agent["id"]}],
        user_id="alice",
        is_admin=False,
        agent_store=agents,
        placement_store=placements,
        daemon_nodes=[
            {
                **node(
                    "node_new",
                    "codex",
                    workspace_id="managed:computer_one",
                ),
                "managedNodeId": "computer_one",
                "userId": "alice",
            }
        ],
        session=session,
    )

    assert resolved[0]["daemonNodeId"] == "node_new"


def test_managed_runtime_replacement_keeps_pre_run_session_affinity(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(
        agent,
        "node_new",
        {"managedNodeId": "computer_one"},
    )
    session = {
        "id": "ses_existing",
        "daemonNodeId": "node_old",
        "managedNodeId": "computer_one",
        "workspacePath": "/workspace",
        "agentRuns": [],
    }

    resolved = resolve_agent_assignments(
        [{"agentId": agent["id"]}],
        user_id="alice",
        is_admin=False,
        agent_store=agents,
        placement_store=placements,
        daemon_nodes=[
            {
                **node(
                    "node_new",
                    "codex",
                    workspace_id="managed:computer_one",
                ),
                "managedNodeId": "computer_one",
                "userId": "alice",
            }
        ],
        session=session,
    )

    assert resolved[0]["daemonNodeId"] == "node_new"


def test_legacy_pre_run_session_follows_managed_runtime_history(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_new", {"managedNodeId": "computer_one"})
    session = {
        "id": "ses_legacy",
        "daemonNodeId": "node_old",
        "workspacePath": "/workspace",
        "agentRuns": [],
    }
    new_node = {
        **node("node_new", "codex"),
        "managedNodeId": "computer_one",
        "userId": "alice",
    }

    resolved = resolve_agent_assignments(
        [{"agentId": agent["id"]}],
        user_id="alice",
        is_admin=False,
        agent_store=agents,
        placement_store=placements,
        daemon_nodes=[new_node],
        session=session,
        daemon_store=SimpleNamespace(
            historical_managed_node_id=lambda runtime_id: (
                "computer_one" if runtime_id == "node_old" else None
            )
        ),
    )

    assert resolved[0]["daemonNodeId"] == "node_new"


def test_shared_path_session_rejects_followup_on_different_node(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    first = agents.create_agent(
        "alice",
        {
            "displayName": "First",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    second = agents.create_agent(
        "alice",
        {
            "displayName": "Second",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    first_placement = placements.create_placement(
        first, "node_a", {"workspacePolicy": {"kind": "shared-path"}}
    )
    placements.create_placement(
        second, "node_b", {"workspacePolicy": {"kind": "shared-path"}}
    )
    session = {
        "id": "ses_existing",
        "workspacePath": "/workspace/alice",
        "agentRuns": [
            {
                "logicalAgentId": first["id"],
                "placementId": first_placement["id"],
                "daemonNodeId": "node_a",
            }
        ],
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": second["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[
                node("node_a", "claude", workspace_id="repo:relay"),
                node("node_b", "codex", workspace_id="repo:relay"),
            ],
            session=session,
        )

    assert error.value.code == "workspace_unavailable"


def test_offline_agent_returns_stable_reason(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_a")

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[{**node("node_a", "codex"), "online": False}],
        )

    assert error.value.code == "node_offline"


def test_saturated_placement_returns_capacity_exhausted(tmp_path: Path) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_a")
    saturated = {
        **node("node_a", "codex"),
        "status": "running",
        "activeRuns": [{"sessionId": "ses_other"}],
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[saturated],
        )

    assert error.value.code == "capacity_exhausted"


def test_device_compatibility_agent_does_not_borrow_managed_capacity(
    tmp_path: Path,
) -> None:
    """A device's stand-in agent stays on its device when that device is down.

    Placing it on the user's managed Computer would relocate it for good,
    so every thread already pinned to the device would start rejecting it with
    workspace_unavailable.
    """
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.ensure_compatibility_agent("alice", "claude", "device_node")
    original = placements.create_placement(agent, "device_node")
    offline_device = {
        **node("device_node", "claude"),
        "userId": "alice",
        "online": False,
        "stale": True,
        "status": "stopped",
    }
    managed = {
        **node("managed_runtime", "claude"),
        "userId": "alice",
        "managedNodeId": "computer_managed",
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[offline_device, managed],
        )

    assert error.value.code == "node_offline"
    [preserved] = placements.list_placements(agent_id=agent["id"])
    assert preserved["id"] == original["id"]
    assert preserved["daemonNodeId"] == "device_node"


def test_assignment_does_not_borrow_another_managed_computer(tmp_path: Path) -> None:
    """原机器离线时，派发必须失败而不是改派到另一台托管机器。"""
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Worker",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node-home", {"managedNodeId": "mnode-home"})
    offline_home = {
        **node("node-home", "claude"),
        "userId": "alice",
        "managedNodeId": "mnode-home",
        "online": False,
        "stale": True,
        "status": "stopped",
    }
    spare = {
        **node("node-spare", "claude"),
        "userId": "alice",
        "managedNodeId": "mnode-spare",
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[offline_home, spare],
        )

    assert error.value.code == "node_offline"
    [preserved] = placements.list_placements(agent_id=agent["id"])
    assert preserved["daemonNodeId"] == "node-home"


def test_phantom_placement_with_run_history_does_not_attach_elsewhere(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    sessions = make_session_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Worker",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    placement = placements.create_placement(agent, "node-missing")
    session = sessions.create_session(
        {"workspacePath": "/workspace", "taskGoal": "Existing work"}
    )
    sessions.append_event(
        session["id"],
        relay_event(
            "agent.started",
            session["id"],
            {
                "runId": "run-1",
                "agent": "claude",
                "logicalAgentId": agent["id"],
                "placementId": placement["id"],
                "daemonNodeId": "node-missing",
            },
        ),
    )
    spare = {
        **node("node-spare", "claude"),
        "userId": "alice",
        "managedNodeId": "mnode-spare",
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[spare],
            session_store=sessions,
        )

    assert error.value.code == "agent_offline"
    assert len(placements.list_placements(agent_id=agent["id"])) == 1


def test_phantom_placement_does_not_attach_to_non_ready_executor(
    tmp_path: Path,
) -> None:
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    sessions = make_session_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Worker",
            "executorKind": "claude",
            "defaultRole": "implementer",
        },
    )
    original = placements.create_placement(agent, "node-missing")
    non_ready = {
        **node("node-spare", "claude"),
        "userId": "alice",
        "managedNodeId": "mnode-spare",
        "agents": {"claude": "error"},
        "supportedAgents": ["claude"],
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[non_ready],
            session_store=sessions,
        )

    assert error.value.code == "agent_offline"
    [preserved] = placements.list_placements(agent_id=agent["id"])
    assert preserved["id"] == original["id"]


def test_placement_resolves_to_the_same_computer_under_a_new_node_id() -> None:
    from relay.agents.routing import placement_node

    placement = {"daemonNodeId": "node-old", "computerId": "device:alice:machine-a"}
    nodes = {
        "node-new": {
            "id": "node-new",
            "userId": "alice",
            "workspaceId": "machine-a",
        }
    }
    assert placement_node(placement, nodes)["id"] == "node-new"


def test_legacy_placement_without_computer_id_falls_back_to_node_id() -> None:
    from relay.agents.routing import placement_node

    placement = {"daemonNodeId": "node-old"}
    nodes = {"node-old": {"id": "node-old"}}
    assert placement_node(placement, nodes)["id"] == "node-old"


def test_placement_node_is_none_when_the_computer_is_offline() -> None:
    from relay.agents.routing import placement_node

    placement = {"daemonNodeId": "node-old", "computerId": "device:alice:machine-a"}
    assert placement_node(placement, {}) is None


def test_thread_follows_its_computer_across_a_new_node_id() -> None:
    from relay.agents.routing import resolve_session_daemon_node_id

    session = {"id": "s1", "computerId": "device:alice:machine-a"}
    nodes = [
        {
            "id": "node-new",
            "userId": "alice",
            "workspaceId": "machine-a",
            "online": True,
            "stale": False,
            "status": "ready",
        }
    ]
    assert resolve_session_daemon_node_id(session, nodes) == "node-new"


def test_offline_computer_resolves_to_nothing_instead_of_borrowing() -> None:
    from relay.agents.routing import resolve_session_daemon_node_id

    session = {"id": "s1", "computerId": "device:alice:machine-a"}
    other_machine = [
        {
            "id": "node-other",
            "userId": "alice",
            "workspaceId": "machine-b",
            "online": True,
            "stale": False,
            "status": "ready",
        }
    ]
    assert resolve_session_daemon_node_id(session, other_machine) is None


def test_offline_runtime_on_the_same_computer_resolves_to_nothing() -> None:
    from relay.agents.routing import resolve_session_daemon_node_id

    session = {"id": "s1", "computerId": "managed:mnode-7"}
    offline = [
        {
            "id": "node-old",
            "managedNodeId": "mnode-7",
            "online": False,
            "stale": True,
            "status": "stopped",
        }
    ]
    assert resolve_session_daemon_node_id(session, offline) is None


def test_online_node_wins_over_an_offline_one_on_the_same_computer() -> None:
    from relay.agents.routing import resolve_session_daemon_node_id

    session = {"id": "s1", "computerId": "managed:mnode-7"}
    nodes = [
        {
            "id": "node-a",
            "managedNodeId": "mnode-7",
            "online": False,
            "status": "stopped",
        },
        {
            "id": "node-b",
            "managedNodeId": "mnode-7",
            "online": True,
            "stale": False,
            "status": "ready",
        },
    ]
    assert resolve_session_daemon_node_id(session, nodes) == "node-b"


def test_session_without_computer_id_falls_back_to_its_recorded_node() -> None:
    from relay.agents.routing import resolve_session_daemon_node_id

    session = {"id": "s1", "daemonNodeId": "node-old"}
    assert resolve_session_daemon_node_id(session, []) == "node-old"


def test_legacy_session_with_managed_node_id_resolves_without_computer_id() -> None:
    from relay.agents.routing import resolve_session_daemon_node_id

    session = {
        "id": "s1",
        "daemonNodeId": "node-old",
        "managedNodeId": "computer_one",
    }
    nodes = [
        {
            "id": "node-new",
            "managedNodeId": "computer_one",
            "online": True,
            "stale": False,
            "status": "ready",
        }
    ]
    assert resolve_session_daemon_node_id(session, nodes) == "node-new"


def test_offline_computer_id_thread_refuses_instead_of_borrowing(
    tmp_path: Path,
) -> None:
    """A pre-run thread pinned to a Computer that isn't online must refuse
    dispatch, not silently pick a different machine (spec §4)."""
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_b")
    session = {
        "id": "ses_pending",
        "computerId": "device:alice:machine-a",
        "workspacePath": "/workspace",
        "agentRuns": [],
    }
    other_machine = {
        **node("node_b", "codex", workspace_id="machine-b"),
        "userId": "alice",
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[other_machine],
            session=session,
        )

    assert error.value.code == "node_offline"


def test_offline_managed_node_id_thread_refuses_instead_of_borrowing(
    tmp_path: Path,
) -> None:
    """Same guarantee for the pre-computerId managedNodeId shape."""
    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placements.create_placement(agent, "node_b")
    session = {
        "id": "ses_pending",
        "managedNodeId": "computer_one",
        "workspacePath": "/workspace",
        "agentRuns": [],
    }
    other_managed_node = {
        **node("node_b", "codex"),
        "userId": "alice",
        "managedNodeId": "computer_two",
    }

    with pytest.raises(AgentRoutingError) as error:
        resolve_agent_assignments(
            [{"agentId": agent["id"]}],
            user_id="alice",
            is_admin=False,
            agent_store=agents,
            placement_store=placements,
            daemon_nodes=[other_managed_node],
            session=session,
        )

    assert error.value.code == "node_offline"


def test_legacy_rebind_chasing_uses_the_latest_run_with_a_daemon_node_id(
    tmp_path: Path,
) -> None:
    """resolve_legacy_session_computer_id must anchor on the most recent run
    that actually has a daemonNodeId, even when that run has no placementId
    — it must not skip past it to chase an older run's placement rebind."""
    from relay.agents.routing import resolve_legacy_session_computer_id

    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    old_placement = placements.create_placement(agent, "node_old")
    placements.rebind_placement(old_placement["id"], "node_stale_target")
    session = {
        "id": "ses_existing",
        "workspacePath": "/workspace",
        "agentRuns": [
            {
                "logicalAgentId": agent["id"],
                "placementId": old_placement["id"],
                "daemonNodeId": "node_old",
            },
            {
                "logicalAgentId": agent["id"],
                "daemonNodeId": "node_newer",
                # No placementId on the latest run: rebind-chasing must stop
                # here rather than falling back to the older run above.
            },
        ],
    }
    nodes = {
        "node_stale_target": {
            "id": "node_stale_target",
            "managedNodeId": "computer_stale",
        },
    }

    assert (
        resolve_legacy_session_computer_id(
            session, placements, nodes, daemon_store=None
        )
        is None
    )


def test_legacy_session_recovers_device_identity_from_its_run_placement(
    tmp_path: Path,
) -> None:
    from relay.persistence.agent.placements import create_node_placement
    from relay.agents.routing import resolve_legacy_session_computer_id

    agents = make_agent_store(tmp_path)
    placements = make_agent_placement_store(tmp_path)
    agent = agents.create_agent(
        "alice",
        {
            "displayName": "Builder",
            "executorKind": "codex",
            "defaultRole": "implementer",
        },
    )
    placement = create_node_placement(
        placements,
        agent,
        {
            "id": "node-old",
            "userId": "alice",
            "workspaceId": "machine-a",
        },
    )
    session = {
        "id": "ses-legacy",
        "daemonNodeId": "node-old",
        "agentRuns": [
            {
                "daemonNodeId": "node-old",
                "placementId": placement["id"],
            }
        ],
    }

    assert (
        resolve_legacy_session_computer_id(session, placements, {}, daemon_store=None)
        == "device:alice:machine-a"
    )
