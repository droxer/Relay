"""Put test work inside a project.

An issue outside a project never runs (relay/services/issue_triage.py), so a
test that exercises dispatch mechanics — retries, blockers, WIP, teams — gives
its work a project on the computer its agents already share. The project is
the smallest one dispatch accepts: the first agent leads, every agent listed
is an enabled member.
"""

from __future__ import annotations

from typing import Any

from relay.core.computer_identity import computer_id

PROJECT_CAPABILITY = "project-workspaces"


def project_for(
    project_store: Any,
    owner: str,
    node: dict[str, Any],
    agent_ids: list[str],
    *,
    name: str = "Test project",
) -> dict[str, Any]:
    return project_store.create_project(owner, {
        "name": name,
        "computerId": computer_id(node),
        "leadAgentId": agent_ids[0],
        "members": [
            {"agentId": agent_id, "role": "implementer", "responsibilities": "Deliver", "enabled": True}
            for agent_id in agent_ids
        ],
    })


def project_for_agents(
    project_store: Any,
    owner: str,
    agents: list[dict[str, Any]],
    *,
    name: str = "Test project",
) -> dict[str, Any]:
    """A project on the computer the (first) agent was declared on."""
    return project_store.create_project(owner, {
        "name": name,
        "computerId": agents[0]["computerId"],
        "leadAgentId": agents[0]["id"],
        "members": [
            {"agentId": agent["id"], "role": "implementer", "responsibilities": "Deliver", "enabled": True}
            for agent in agents
        ],
    })


def project_for_team(app: Any, owner: str, team: dict[str, Any], *, name: str = "Team project") -> dict[str, Any]:
    """A project whose roster is the team, lead first, on the computer the
    team actually runs on: the lead's placement, else its declared computer."""
    ids = [team["leadAgentId"], *[i for i in team["memberAgentIds"] if i != team["leadAgentId"]]]
    agents = [app.state.agent_store.get_agent(agent_id) for agent_id in ids]
    live = [
        placement
        for placement in app.state.agent_placement_store.list_placements(agent_id=ids[0])
        if placement.get("desiredState") != "removed" and placement.get("computerId")
    ]
    computer = live[-1]["computerId"] if live else agents[0]["computerId"]
    return project_store_create(app.state.project_store, owner, computer, agents, name=name)


def project_store_create(
    project_store: Any, owner: str, computer: str, agents: list[dict[str, Any]], *, name: str
) -> dict[str, Any]:
    return project_store.create_project(owner, {
        "name": name,
        "computerId": computer,
        "leadAgentId": agents[0]["id"],
        "members": [
            {"agentId": agent["id"], "role": "implementer", "responsibilities": "Deliver", "enabled": True}
            for agent in agents
        ],
    })


def routine_run_with_session(app: Any, title: str, workspace_path: str = "/workspace") -> dict[str, Any]:
    """A projectless occurrence with a thread, for file and lifecycle API tests."""
    from relay.sessions import SessionController

    task = app.state.task_store.create_task({
        "title": title, "ownerEmployeeId": "admin", "sourceRoutineId": "routine_nightly",
    })
    controller = SessionController(
        app.state.session_store, task_store=app.state.task_store,
        task_id=task["id"], workspace_path=workspace_path, owner_employee_id="admin",
    )
    controller.create_session(title, ["human"])
    return app.state.task_store.get_task(task["id"])
