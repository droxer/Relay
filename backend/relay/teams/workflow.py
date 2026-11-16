"""Live Project admission for workflow definition writes."""
from __future__ import annotations

from typing import Any

from ..agents.location import agent_placed_on_computer
from ..core.computer_identity import computer_id
from ..core.team_workflows import workflow_fields
from ..persistence.team.store import TeamValidationError, validate_team_payload
from .computer import resolve_team_computer


def validate_workflow_write(
    ctx: Any, owner_user_id: str, body: dict[str, Any],
    *, current: dict[str, Any] | None = None,
) -> None:
    fields = workflow_fields(body, current=current)
    if not fields:
        return
    project = ctx.project_store.get_project(fields["projectId"])
    if not project or project.get("archivedAt"):
        raise TeamValidationError("team_workflow_project_not_found")
    if project.get("ownerUserId") != owner_user_id:
        raise TeamValidationError("team_workflow_project_forbidden")
    if not project.get("enabled", True):
        raise TeamValidationError("team_workflow_project_disabled")
    merged = {**(current or {}), **body}
    _, members = validate_team_payload(owner_user_id, merged, ctx.agent_store)
    enabled = {member["agentId"] for member in project.get("members", []) if member.get("enabled", True)}
    if any(member not in enabled for member in members):
        raise TeamValidationError("team_workflow_project_not_member")
    if merged.get("computerId", project["computerId"]) != project["computerId"]:
        raise TeamValidationError("team_workflow_computer_mismatch")
    resolve_team_computer(
        owner_user_id, {**merged, "computerId": project["computerId"]}, members,
        current=current, registry=ctx.registry, agent_store=ctx.agent_store,
        placement_store=ctx.agent_placement_store,
    )
    nodes = {node["id"] for node in ctx.registry.monitor_nodes() if computer_id(node) == project["computerId"]}
    for member in members:
        agent = ctx.agent_store.get_agent(member)
        if not agent.get("enabled", True):
            raise TeamValidationError("team_workflow_agent_disabled")
        if not agent_placed_on_computer(
            member, project["computerId"], node_ids=nodes, placement_store=ctx.agent_placement_store,
        ):
            raise TeamValidationError("team_workflow_agent_unplaced")
