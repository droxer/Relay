from __future__ import annotations

from types import SimpleNamespace

import pytest
from relay.services.project_runtime import (
    ProjectDispatchError,
    project_member_assignments,
    resolve_project_task_assignments,
)


def _project(*, enabled: bool = True) -> dict:
    return {
        "id": "project-1",
        "ownerEmployeeId": "alice",
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
            {"projectId": "project-1", "ownerEmployeeId": "alice"},
            project_store=Store(),
            agent_store=None,
            placement_store=None,
            daemon_nodes=[],
        )

    assert raised.value.code == "project_disabled"
    assert raised.value.permanent is False


@pytest.mark.parametrize("task_style, expected", [
    (None, ["lead", "builder", "reviewer"]),
    ("solo", ["builder"]),
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
        "id": "team", "ownerEmployeeId": "alice", "leadAgentId": "lead",
        "memberAgentIds": ["lead", "builder", "reviewer"],
        "collaborationStyle": "pipeline",
    }

    def resolve(assignments, **kwargs):
        assert kwargs["required_node_id"] == "node"
        assert kwargs["employee_id"] == "alice"
        return assignments

    monkeypatch.setattr("relay.services.project_runtime.resolve_agent_assignments", resolve)
    assignments, snapshot = resolve_project_task_assignments(
        {"projectId": project["id"], "assignedTeamId": team["id"],
         "ownerEmployeeId": "alice", "collaborationStyle": task_style},
        project_store=SimpleNamespace(get_project=lambda _: project),
        team_store=SimpleNamespace(get_team=lambda _: team),
        agent_store=SimpleNamespace(get_agent=agents.get),
        placement_store=None,
        daemon_nodes=[{
            "id": "node", "employeeId": "alice", "workspaceId": "main", "online": True,
            "status": "ready", "capabilities": ["project-workspaces"],
        }],
    )
    assert [item["agentId"] for item in assignments] == expected
    assert all(item["teamSnapshot"]["collaborationStyle"] == (task_style or "pipeline")
               for item in assignments)
    assert all(item["projectSnapshot"] == snapshot for item in assignments)
    assert snapshot["projectId"] == project["id"]
