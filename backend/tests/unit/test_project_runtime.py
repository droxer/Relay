from __future__ import annotations

from types import SimpleNamespace

import pytest
from relay.projects.runtime import (
    ProjectDispatchError,
    project_member_assignments,
    project_runtime_node,
    project_thread_assignments,
    project_runtime_snapshot,
    project_styled_assignments,
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


def test_project_preset_accepts_legacy_placements_and_uses_agent_profiles():
    project = _project()
    reviewer, *_, builder = project["members"]
    project["members"] = [{**reviewer, "role": "implementer", "roleLevel": "junior"}, builder]
    agents = SimpleNamespace(get_agent=lambda agent_id: {
        "id": agent_id, "supervisorUserId": "alice",
        "defaultRole": "reviewer" if agent_id == "reviewer" else "implementer",
    })
    placements = SimpleNamespace(list_placements=lambda *, agent_id: [{
        "agentId": agent_id, "desiredState": "active", "daemonNodeId": "legacy-node",
    }])
    assignments, _ = project_styled_assignments(
        project, style="pipeline", agent_store=agents, placement_store=placements,
        daemon_nodes=[{"id": "legacy-node", "userId": "alice", "workspaceId": "main"}],
    )
    assert [(item["agentId"], item["role"]) for item in assignments] == [
        ("builder", "implementer"), ("reviewer", "reviewer"),
    ]
    assert "roleLevel" not in assignments[1]


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


def test_project_task_refuses_a_saved_team_assignment():
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

    with pytest.raises(ProjectDispatchError) as raised:
        resolve_project_task_assignments(
            {"projectId": project["id"], "assignedTeamId": team["id"],
             "ownerUserId": "alice"},
            project_store=SimpleNamespace(get_project=lambda _: project),
            team_store=SimpleNamespace(get_team=lambda _: team),
            agent_store=SimpleNamespace(get_agent=agents.get),
            placement_store=None,
            daemon_nodes=[{
                "id": "node", "userId": "alice", "workspaceId": "main", "online": True,
                "status": "ready", "capabilities": ["project-workspaces"],
            }],
        )

    # A saved assignment predating this rule must be reassigned: no Team runs
    # a Project Task, and the refusal is permanent until the person acts.
    assert raised.value.code == "project_team_assignment_forbidden"
    assert raised.value.permanent is True


_NODE = {
    "id": "node", "userId": "alice", "workspaceId": "main", "online": True,
    "status": "ready", "capabilities": ["project-workspaces"],
}


def _crewless_project() -> dict:
    return {**_project(), "members": [], "leadAgentId": None}


def test_crewless_project_refuses_a_task_assigned_to_a_non_member():
    with pytest.raises(ProjectDispatchError) as raised:
        resolve_project_task_assignments(
            {"projectId": "project-1", "ownerUserId": "alice", "assignedAgentId": "alex"},
            project_store=SimpleNamespace(get_project=lambda _: _crewless_project()),
            agent_store=None,
            placement_store=None,
            daemon_nodes=[_NODE],
        )
    assert raised.value.code == "project_agent_not_member"
    assert raised.value.permanent is True


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


def _placements(on_computer: set[str]):
    def list_placements(*, agent_id: str):
        computer = "device:alice:main" if agent_id in on_computer else "device:alice:other"
        return [{"computerId": computer, "desiredState": "active"}]
    return SimpleNamespace(list_placements=list_placements)


def _thread_assignments(project, selected, room=(), on_computer=frozenset()):
    return project_thread_assignments(
        project,
        mode="action",
        selected_agent_ids=selected,
        room_agent_ids=list(room),
        snapshot=project_runtime_snapshot(project),
        agent_store=SimpleNamespace(get_agent=lambda agent_id: {"id": agent_id}),
        placement_store=_placements(set(on_computer)),
    )


def test_addressing_crew_members_without_the_lead_names_no_coordinator():
    assignments = _thread_assignments(_project(), ["builder", "reviewer"])

    assert [item["agentId"] for item in assignments] == ["builder", "reviewer"]
    assert not any(item["coordinator"] for item in assignments)


def test_crewless_room_skips_agents_that_left_the_project_computer():
    assignments = _thread_assignments(
        _crewless_project(), None, room=["alex", "gone"], on_computer={"alex"}
    )

    assert [item["agentId"] for item in assignments] == ["alex"]


def test_addressing_an_agent_off_the_project_computer_is_refused():
    with pytest.raises(ProjectDispatchError) as raised:
        _thread_assignments(_crewless_project(), ["gone"], on_computer={"alex"})

    assert raised.value.code == "project_agent_off_computer"


def _preset_world(selection):
    agents = SimpleNamespace(get_agent=lambda agent_id: {
        "id": agent_id, "supervisorUserId": "alice", "defaultRole": "implementer",
    })
    return {**_project(), "predefinedWorkflows": selection}, agents


def _preset(project, agents, style):
    placements = SimpleNamespace(list_placements=lambda *, agent_id: [{
        "agentId": agent_id, "desiredState": "active", "daemonNodeId": "legacy-node",
    }])
    return project_styled_assignments(
        project, style=style, agent_store=agents, placement_store=placements,
        daemon_nodes=[{"id": "legacy-node", "userId": "alice", "workspaceId": "main"}],
    )


def test_preset_runs_only_the_selected_agents_and_records_them():
    project, agents = _preset_world({"pipeline": {"agentIds": ["builder", "reviewer", "gone"]}})
    assignments, snapshot = _preset(project, agents, "pipeline")
    assert {item["agentId"] for item in assignments} == {"builder", "reviewer"}
    assert sorted(snapshot["participantAgentIds"]) == ["builder", "reviewer"]


def test_lead_led_selection_always_keeps_the_lead():
    project, agents = _preset_world({"lead_led": {"agentIds": ["builder"]}})
    assignments, _ = _preset(project, agents, "lead_led")
    assert {item["agentId"] for item in assignments} == {"lead", "builder"}


def test_selection_with_no_enabled_member_fails_closed():
    project, agents = _preset_world({"pipeline": {"agentIds": ["gone"]}})
    with pytest.raises(ProjectDispatchError) as error:
        _preset(project, agents, "pipeline")
    assert error.value.code == "project_roster_invalid" and error.value.permanent
