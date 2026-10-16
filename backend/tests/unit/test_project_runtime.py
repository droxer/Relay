from __future__ import annotations

from types import SimpleNamespace

import pytest
from relay.services.project_runtime import (
    ProjectDispatchError,
    project_member_assignments,
    project_runtime_node,
    resolve_project_task_assignments,
)


def test_linked_project_routing_skips_an_older_sibling_daemon():
    project = {**_project(), "workspaceSubpath": "links/repo"}
    older = {
        "id": "a-older", "userId": "alice", "workspaceId": "main",
        "online": True, "status": "ready", "capabilities": ["project-workspaces"],
    }
    capable = {**older, "id": "b-capable", "capabilities": ["project-workspaces", "project-links"]}
    assert project_runtime_node(project, [older, capable]) == capable
    assert project_runtime_node(project, [older]) is None
    assert project_runtime_node(_project(), [older]) == older


def _project(*, enabled: bool = True) -> dict:
    return {
        "id": "project-1",
        "ownerUserId": "alice",
        "computerId": "device:alice:main",
        "workspaceSubpath": "projects/project-1",
        "leadAgentId": "lead",
        "enabled": enabled,
        "version": 1,
        "members": [
            {
                "agentId": "reviewer",
                "role": "reviewer",
                "responsibilities": "Review",
                "enabled": True,
            },
            {
                "agentId": "lead",
                "role": "planner",
                "responsibilities": "Lead",
                "enabled": True,
            },
            {
                "agentId": "tester",
                "role": "tester",
                "responsibilities": "Test",
                "enabled": True,
            },
            {
                "agentId": "builder",
                "role": "implementer",
                "responsibilities": "Build",
                "enabled": True,
            },
        ],
    }


def test_project_roster_runs_lead_first_then_keeps_configured_order() -> None:
    assignments = project_member_assignments(_project())

    assert [assignment["agentId"] for assignment in assignments] == [
        "lead",
        "reviewer",
        "tester",
        "builder",
    ]


def test_disabled_project_is_a_transient_dispatch_failure() -> None:
    class Store:
        def get_project(self, project_id: str) -> dict:
            assert project_id == "project-1"
            return _project(enabled=False)

    with pytest.raises(ProjectDispatchError) as raised:
        resolve_project_task_assignments(
            {"projectId": "project-1", "ownerUserId": "alice"},
            project_store=Store(),
            agent_store=None,
            placement_store=None,
            daemon_nodes=[],
        )

    assert raised.value.code == "project_disabled"
    assert raised.value.permanent is False


@pytest.mark.parametrize("task_style, expected", [
    (None, ["lead", "builder", "reviewer"]),
    ("pipeline", ["lead", "builder", "reviewer"]),
    ("build_review", ["builder", "reviewer"]),
])
def test_project_team_task_preserves_style_and_workspace(monkeypatch, task_style, expected):
    project = _project()
    agents = {
        member["agentId"]: {
            "id": member["agentId"], "executorKind": "codex",
            "defaultRole": member["role"], "enabled": True,
        }
        for member in project["members"]
    }
    team = {
        "id": "team", "ownerUserId": "alice", "leadAgentId": "lead",
        "memberAgentIds": ["lead", "builder", "reviewer"],
        "collaborationStyle": "pipeline",
    }

    def resolve(assignments, **kwargs):
        assert kwargs["required_node_id"] == "node"
        assert kwargs["user_id"] == "alice"
        return assignments

    monkeypatch.setattr("relay.services.project_runtime.resolve_agent_assignments", resolve)
    assignments, snapshot = resolve_project_task_assignments(
        {"projectId": project["id"], "assignedTeamId": team["id"],
         "ownerUserId": "alice", "collaborationStyle": task_style},
        project_store=SimpleNamespace(get_project=lambda _: project),
        team_store=SimpleNamespace(get_team=lambda _: team),
        agent_store=SimpleNamespace(get_agent=agents.get),
        placement_store=None,
        daemon_nodes=[{
            "id": "node", "userId": "alice", "workspaceId": "main", "online": True,
            "status": "ready", "capabilities": ["project-workspaces"],
        }],
    )
    assert [item["agentId"] for item in assignments] == expected
    assert all(item["teamSnapshot"]["collaborationStyle"] == (task_style or "pipeline")
               for item in assignments)
    assert all(item["projectSnapshot"] == snapshot for item in assignments)
    assert snapshot["projectId"] == project["id"]


_NODE = {
    "id": "node", "userId": "alice", "workspaceId": "main", "online": True,
    "status": "ready", "capabilities": ["project-workspaces"],
}


def _crewless_project() -> dict:
    return {**_project(), "members": [], "leadAgentId": None}


def test_crewless_project_runs_a_task_assigned_to_an_agent_on_its_computer(monkeypatch):
    monkeypatch.setattr(
        "relay.services.project_runtime.resolve_agent_assignments",
        lambda assignments, **kwargs: assignments,
    )
    assignments, snapshot = resolve_project_task_assignments(
        {"projectId": "project-1", "ownerUserId": "alice", "assignedAgentId": "alex"},
        project_store=SimpleNamespace(get_project=lambda _: _crewless_project()),
        agent_store=SimpleNamespace(get_agent=lambda _: {"id": "alex", "defaultRole": "implementer"}),
        placement_store=None,
        daemon_nodes=[_NODE],
    )

    assert [item["agentId"] for item in assignments] == ["alex"]
    assert assignments[0]["coordinator"] is True
    assert snapshot["leadAgentId"] is None
    assert snapshot["members"] == []


def test_crewless_project_refuses_a_task_that_names_no_one():
    with pytest.raises(ProjectDispatchError) as raised:
        resolve_project_task_assignments(
            {"projectId": "project-1", "ownerUserId": "alice"},
            project_store=SimpleNamespace(get_project=lambda _: _crewless_project()),
            agent_store=None,
            placement_store=None,
            daemon_nodes=[_NODE],
        )

    assert raised.value.code == "project_roster_invalid"
    assert raised.value.permanent is True
