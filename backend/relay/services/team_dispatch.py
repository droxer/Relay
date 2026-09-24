from __future__ import annotations

from typing import Any

from ..collaboration.styles import LEAD_LED, fill_build_review_slots, pipeline_order
from .agent_routing import resolve_agent_assignments

TEAM_UNAVAILABLE_MESSAGE = "The agent team is not currently available."


class TeamDispatchError(ValueError):
    def __init__(
        self,
        code: str = "team_unavailable",
        *,
        permanent: bool = False,
    ):
        self.code = code
        self.permanent = permanent
        super().__init__(code)


def task_execution_employee_id(task: dict[str, Any]) -> str:
    employee_id = task.get("assigneeEmployeeId") or task.get("ownerEmployeeId")
    return employee_id if isinstance(employee_id, str) else ""


def task_thread_ownership(
    task: dict[str, Any], *, team_store: Any, agent_store: Any
) -> dict[str, str]:
    ownership: dict[str, str] = {}
    employee_id = task_execution_employee_id(task)
    if employee_id:
        ownership["owner_employee_id"] = employee_id
    assigned_agent_id = task.get("assignedAgentId")
    if isinstance(assigned_agent_id, str) and assigned_agent_id:
        ownership["owner_agent_id"] = assigned_agent_id
    team_id = task.get("assignedTeamId")
    if isinstance(team_id, str) and team_id:
        # A project thread stays the project's room even when a team runs it.
        if not task.get("projectId"):
            ownership["team_id"] = team_id
        team, _agents = _task_team_agents(
            task, team_store=team_store, agent_store=agent_store
        )
        ownership["owner_agent_id"] = team["leadAgentId"]
    return ownership


def task_thread_assignments(
    task: dict[str, Any],
    supplied_assignments: list[dict[str, Any]],
    *,
    team_store: Any,
    agent_store: Any,
) -> list[dict[str, Any]]:
    team_id = task.get("assignedTeamId")
    if isinstance(team_id, str) and team_id:
        team, agents = _task_team_agents(
            task, team_store=team_store, agent_store=agent_store
        )
        return team_member_assignments(agents, team=team)
    assigned_agent_id = task.get("assignedAgentId")
    assigned_agent = task.get("assignedAgent")
    if assigned_agent_id and assigned_agent:
        return [
            {
                "agentId": assigned_agent_id,
                "agent": assigned_agent,
            }
        ]
    return supplied_assignments


def resolve_team_task_assignments(
    task: dict[str, Any],
    *,
    team_store: Any,
    agent_store: Any,
    placement_store: Any,
    daemon_nodes: list[dict[str, Any]],
    session_store: Any | None = None,
) -> list[dict[str, Any]]:
    team, agents = _task_team_agents(
        task,
        team_store=team_store,
        agent_store=agent_store,
    )
    return resolve_agent_assignments(
        team_member_assignments(agents, team=team),
        employee_id=task_execution_employee_id(task),
        is_admin=False,
        agent_store=agent_store,
        placement_store=placement_store,
        daemon_nodes=daemon_nodes,
        session_store=session_store,
    )


def team_agents(
    team_id: str,
    employee_id: str,
    *,
    team_store: Any,
    agent_store: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Resolve a team to its ordered, dispatchable members. Lead first.

    The single validation point for "can this team run work right now",
    shared by task dispatch and by thread continuation.
    """
    team = team_store.get_team(team_id) if team_store and team_id else None
    if not team or team.get("deletedAt"):
        raise TeamDispatchError("team_not_found", permanent=True)
    if not team.get("enabled", True):
        raise TeamDispatchError("team_disabled", permanent=True)
    if team.get("ownerEmployeeId") != employee_id:
        raise TeamDispatchError("team_forbidden", permanent=True)
    members = list(team.get("memberAgentIds") or [])
    lead = team.get("leadAgentId")
    if not isinstance(lead, str) or lead not in members:
        raise TeamDispatchError("team_invalid", permanent=True)
    ordered_member_ids = [lead, *(member for member in members if member != lead)]
    agents = [agent_store.get_agent(member) for member in ordered_member_ids]
    if any(not agent or agent.get("deletedAt") for agent in agents):
        raise TeamDispatchError("team_invalid", permanent=True)
    if any(
        not agent.get("enabled", True)
        and (agent["id"] == lead or (team.get("memberConfigs", {}).get(agent["id"], {}).get("participation") != "on_request"))
        for agent in agents
    ):
        raise TeamDispatchError("team_disabled", permanent=True)
    return team, agents


def team_member_assignments(
    agents: list[dict[str, Any]],
    *,
    mode: str = "action",
    team: dict[str, Any] | None = None,
    include_on_request: bool = False,
    style: str = LEAD_LED,
) -> list[dict[str, Any]]:
    roster = agents
    lead_agent_id = team.get("leadAgentId") if team else None
    snapshot = (
        team_runtime_snapshot(team, roster, style=LEAD_LED if mode == "action" else None)
        if team
        else None
    )
    configs = (team or {}).get("memberConfigs", {})
    agents = [
        {**agent, "defaultRole": configs.get(agent["id"], {}).get("role", agent.get("defaultRole"))}
        for agent in agents
        if include_on_request or agent["id"] == lead_agent_id
        or configs.get(agent["id"], {}).get("participation") != "on_request"
    ]
    if team and mode == "action" and style != LEAD_LED:
        return _styled_assignments(agents, roster=roster, team=team, style=style, configs=configs)
    synthesis_round = mode in ("ask", "review")
    ordered_agents = (
        [
            *(agent for agent in agents if agent["id"] != lead_agent_id),
            *(agent for agent in agents if agent["id"] == lead_agent_id),
        ]
        if synthesis_round and lead_agent_id
        else _ordered_accomplish_agents(agents, lead_agent_id)
    )
    assignments = [
        _team_member_assignment(
            agent,
            mode=mode,
            coordinator=(agent["id"] == lead_agent_id if lead_agent_id else index == 0),
            synthesizer=bool(
                synthesis_round and lead_agent_id and agent["id"] == lead_agent_id
            ),
            team_snapshot=snapshot,
        )
        for index, agent in enumerate(ordered_agents)
    ]
    if snapshot and mode == "action" and len(assignments) > 1:
        snapshot["workContractVersion"] = 1
    for assignment in assignments:
        config = configs.get(assignment["agentId"], {})
        if team:
            assignment["required"] = (
                True if assignment.get("coordinator") else config.get(
                    "required", config.get("participation") != "on_request"
                )
            )
            assignment["acceptanceCriteria"] = list(team.get("acceptanceCriteria", []))
            assignment["expectedOutputs"] = list(config.get("expectedOutputs", []))
        if config.get("responsibility"):
            assignment["brief"] += " Responsibility: " + config["responsibility"]
    if team and not synthesis_round and len(assignments) > 1:
        lead = next((agent for agent in agents if agent["id"] == lead_agent_id), None)
        if lead:
            assignments.append({
                **_team_member_assignment(lead, mode=mode, synthesizer=True, team_snapshot=snapshot),
                "required": True,
                "acceptanceCriteria": list(team.get("acceptanceCriteria", [])),
            })
    elif team and len(assignments) == 1:
        assignments[0]["synthesizer"] = True
    return assignments


_STYLE_BRIEFS = {
    "solo": "Complete the shared goal yourself and report the delivered result to the user.",
    "builder": (
        "Implement the shared goal. A teammate reviews your work next; if it reports "
        "findings you will be asked to repair them."
    ),
    "reviewer": (
        "Review the builder's changes against the goal and acceptance criteria. Report "
        "findings on the builder's work item to request changes. Report done with "
        "evidence only when the result is acceptable, then summarize what was delivered "
        "for the user."
    ),
}


def _styled_assignments(
    agents: list[dict[str, Any]],
    *,
    roster: list[dict[str, Any]],
    team: dict[str, Any],
    style: str,
    configs: dict[str, Any],
) -> list[dict[str, Any]]:
    """Compile one accomplish round for a non-Lead-led style.

    No assignment is a coordinator: that role means lead planning plus runtime
    repair authority, which only Lead-led grants.
    """
    fallback_from: str | None = None
    slots = fill_build_review_slots(agents, team.get("leadAgentId"))
    if style == "build_review" and slots.reviewer is None:
        style, fallback_from = "solo", "build_review"
    if style == "solo":
        turns = [(slots.builder, "implementer", "action", True, _STYLE_BRIEFS["solo"])]
    elif style == "build_review":
        turns = [
            (slots.builder, "implementer", "action", False, _STYLE_BRIEFS["builder"]),
            (slots.reviewer, "reviewer", "review", True, _STYLE_BRIEFS["reviewer"]),
        ]
    else:
        ordered = pipeline_order(agents)
        last = len(ordered) - 1
        turns = [
            (
                agent,
                agent.get("defaultRole") or "implementer",
                "action",
                index == last,
                _member_brief(agent.get("defaultRole"), False, index == last),
            )
            for index, agent in enumerate(ordered)
        ]
    base_snapshot = team_runtime_snapshot(
        team, roster, style=style, style_fallback_from=fallback_from
    )
    snapshot = (
        {**base_snapshot, "workContractVersion": 1} if len(turns) > 1 else base_snapshot
    )
    return [
        _styled_assignment(agent, role, mode, synthesizer, brief, team, snapshot, configs)
        for agent, role, mode, synthesizer, brief in turns
    ]


def _styled_assignment(
    agent: dict[str, Any],
    role: str,
    mode: str,
    synthesizer: bool,
    brief: str,
    team: dict[str, Any],
    snapshot: dict[str, Any],
    configs: dict[str, Any],
) -> dict[str, Any]:
    config = configs.get(agent["id"], {})
    base = _team_member_assignment(
        {**agent, "defaultRole": role},
        mode=mode,
        synthesizer=synthesizer,
        team_snapshot=snapshot,
    )
    responsibility = config.get("responsibility")
    return {
        **base,
        "brief": f"{brief} Responsibility: {responsibility}" if responsibility else brief,
        "required": True,
        "acceptanceCriteria": list(team.get("acceptanceCriteria", [])),
        "expectedOutputs": list(config.get("expectedOutputs", [])),
    }


def _ordered_accomplish_agents(
    agents: list[dict[str, Any]], lead_agent_id: str | None
) -> list[dict[str, Any]]:
    """Produce a stable topological order for delegated team work.

    The lead establishes the boundary first. Implementers then create the
    change, testers validate that accumulated work, and reviewers inspect the
    completed result. Stable sorting preserves the team's chosen order inside
    each phase.
    """
    if not lead_agent_id:
        return agents
    lead = [agent for agent in agents if agent["id"] == lead_agent_id]
    members = [agent for agent in agents if agent["id"] != lead_agent_id]
    stage = {
        "planner": 0,
        "implementer": 1,
        "fixer": 1,
        "tester": 2,
        "reviewer": 3,
    }
    return [
        *lead,
        *sorted(members, key=lambda agent: stage.get(agent.get("defaultRole"), 1)),
    ]


def team_runtime_snapshot(
    team: dict[str, Any],
    members: list[dict[str, Any]],
    *,
    style: str | None = None,
    style_fallback_from: str | None = None,
) -> dict[str, Any]:
    """Capture the roster, revision, and collaboration style a round used."""
    return {
        "teamId": team["id"],
        **({"workContractVersion": 1} if team.get("memberConfigs") or team.get("acceptanceCriteria") else {}),
        "teamRevision": team.get("updatedAt") or team.get("createdAt"),
        "memberAgentIds": [member["id"] for member in members],
        "leadAgentId": team.get("leadAgentId"),
        **({"collaborationStyle": style} if style else {}),
        **({"styleFallbackFrom": style_fallback_from} if style_fallback_from else {}),
    }


def _task_team_agents(
    task: dict[str, Any],
    *,
    team_store: Any,
    agent_store: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    return team_agents(
        task.get("assignedTeamId") or "",
        task_execution_employee_id(task),
        team_store=team_store,
        agent_store=agent_store,
    )


def _team_member_assignment(
    agent: dict[str, Any],
    *,
    mode: str = "action",
    coordinator: bool = False,
    synthesizer: bool = False,
    team_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    role = agent.get("defaultRole")
    return {
        "agentId": agent["id"],
        "agent": agent["executorKind"],
        "mode": mode,
        "phase": team_assignment_phase(role, mode, coordinator),
        **({"role": role} if role else {}),
        **({"coordinator": True} if coordinator else {}),
        **({"synthesizer": True} if synthesizer else {}),
        "brief": _member_brief(role, coordinator, synthesizer, mode=mode),
        **({"teamSnapshot": team_snapshot} if team_snapshot else {}),
    }


def _member_brief(
    role: str | None, coordinator: bool, synthesizer: bool = False, *, mode: str = "action"
) -> str:
    if synthesizer and mode == "action":
        return (
            "Review every delegated contribution and its evidence against the task goal and "
            "acceptance criteria. Request repairs for unresolved defects; do not declare completion "
            "while required work remains. Then generate one coherent final result for the user, "
            "including delivered changes, validation results, and any remaining limitations."
        )
    if synthesizer:
        return (
            "Synthesize the room's evidence into one coherent final response, "
            "including disagreements, risks, and the recommended next step."
        )
    if coordinator:
        return "Coordinate the round, establish clear boundaries, and keep the shared work coherent."
    if role == "planner":
        return "Develop the plan, dependencies, risks, and open questions for the shared goal."
    if role == "reviewer":
        return "Review the accumulated workspace changes and synthesize blocking issues and missing tests."
    if role == "tester":
        return "Validate the accumulated implementation with focused tests and report reproducible failures."
    if role == "fixer":
        return "Fix confirmed defects in the accumulated implementation without duplicating completed work."
    if role == "implementer":
        return "Implement the part of the shared goal that fits your role and preserve earlier teammates' work."
    return "Contribute a distinct part of the shared goal and avoid duplicating completed teammate work."


def team_assignment_phase(
    role: str | None, requested_mode: str, coordinator: bool = False
) -> str:
    if requested_mode == "ask":
        return "discussion"
    if requested_mode == "review" or (role == "reviewer" and not coordinator):
        return "review"
    return "execution"
