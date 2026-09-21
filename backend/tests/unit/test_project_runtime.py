from __future__ import annotations

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
