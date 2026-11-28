"""Live Project admission for an independent Workflow and optional Team."""
from typing import Any

from ..agents.location import agent_placed_on_computer
from ..core.computer_identity import computer_id
from ..core.workflows import project_workflow_snapshot
from ..persistence.team.store import TeamValidationError


def validate_project_workflow(ctx: Any, definition: dict[str, Any], team: dict[str, Any] | None = None,
                              *, require_enabled: bool = True, project_id: str | None = None) -> dict[str, Any]:
    if definition.get('computerId') and not definition.get('projectId') and not definition.get('ownerTeamId'):
        raise TeamValidationError('workflow_project_scope_required')
    if definition.get('ownerTeamId') and (not team or team['id'] != definition['ownerTeamId']):
        raise TeamValidationError('workflow_team_required')
    project = ctx.project_store.get_project(definition.get('projectId') or project_id) if definition.get('projectId') or project_id else None
    if not project or project.get('archivedAt') or not project.get('enabled', True):
        raise TeamValidationError('team_workflow_project_disabled')
    if project.get('ownerUserId') != definition['ownerUserId']:
        raise TeamValidationError('workflow_project_owner_required')
    if team and (team.get('ownerUserId') != definition['ownerUserId'] or team.get('computerId') != project['computerId']):
        raise TeamValidationError('workflow_team_unavailable')
    enabled = {member['agentId'] for member in project.get('members', []) if member.get('enabled', True)}
    node_ids = {node['id'] for node in ctx.registry.monitor_nodes() if computer_id(node) == project['computerId']}
    for step in definition['workflowSteps']:
        agent = ctx.agent_store.get_agent(step['agentId'])
        if step['agentId'] not in enabled:
            raise TeamValidationError('team_workflow_project_not_member')
        if not agent or agent.get('deletedAt') or not agent.get('enabled', True) or agent.get('supervisorUserId') != definition['ownerUserId']:
            raise TeamValidationError('team_workflow_agent_disabled')
        if not agent_placed_on_computer(step['agentId'], project['computerId'], node_ids=node_ids, placement_store=ctx.agent_placement_store):
            raise TeamValidationError('team_workflow_agent_unplaced')
    snapshot = project_workflow_snapshot(definition if require_enabled else {**definition, 'enabled': True}, project, team)
    return snapshot
