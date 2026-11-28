"""Run a migrated standalone Predefined Workflow through the role compiler."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from ...agents.routing import resolve_agent_assignments
from ...computer.workflows import validate_standalone_workflow
from ...core.computer_identity import computer_id
from ...core.workflow_selection import predefined_style
from ...teams.dispatch import TeamDispatchError, team_member_assignments, task_execution_user_id


def standalone_predefined_for(task: dict[str, Any], workflow_store: Any) -> dict[str, Any] | None:
    workflow_id = task.get('assignedWorkflowId')
    if (task.get('projectId') or task.get('assignedTeamId') or not workflow_id
            or predefined_style(workflow_id) is not None):
        return None
    definition = workflow_store.get_workflow(workflow_id)
    return definition if definition and definition.get('kind') == 'predefined' else None


def resolve_standalone_predefined_assignments(
    task: dict[str, Any], definition: dict[str, Any], *, agent_store: Any, placement_store: Any,
    registry: Any, daemon_nodes: list[dict[str, Any]], session_store: Any,
) -> list[dict[str, Any]]:
    owner = task_execution_user_id(task)
    if definition['ownerUserId'] != task.get('ownerUserId') or definition['ownerUserId'] != owner:
        raise TeamDispatchError('workflow_owner_required', permanent=True)
    identity = definition['computerId']
    if task.get('assignedAgentId') or task.get('computerId') not in (None, identity):
        raise TeamDispatchError('workflow_assignment_conflict', permanent=True)
    try:
        validate_standalone_workflow(SimpleNamespace(
            registry=registry, agent_store=agent_store, agent_placement_store=placement_store,
        ), definition)
    except ValueError as error:
        raise TeamDispatchError(str(error), permanent=True) from error

    policy = definition['predefined']
    lead = policy['leadAgentId']
    member_ids = [lead, *(member for member in policy['memberAgentIds'] if member != lead)]
    roster = [agent_store.get_agent(member) for member in member_ids]
    if any(not agent or agent.get('deletedAt') or not agent.get('enabled', True) for agent in roster):
        raise TeamDispatchError('workflow_agent_unavailable', permanent=True)
    assignments = team_member_assignments(
        roster, team={**policy, 'id': definition['id'], 'updatedAt': definition['updatedAt']},
        style=policy['template'],
    )
    for assignment in assignments:
        snapshot = assignment['teamSnapshot']
        assignment['teamSnapshot'] = {
            **{key: value for key, value in snapshot.items() if key not in {'teamId', 'teamRevision'}},
            'workflowId': definition['id'], 'workflowVersion': definition['updatedAt'],
            'workflowRecordVersion': 1, 'computerId': definition['computerId'],
        }
    return resolve_agent_assignments(
        assignments, user_id=owner, is_admin=False, agent_store=agent_store,
        placement_store=placement_store, session_store=session_store,
        daemon_nodes=[node for node in daemon_nodes if computer_id(node) == identity],
    )
