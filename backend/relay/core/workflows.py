"""Workflow definitions owned by a Team or Project."""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from .ids import new_database_id, now_iso
from .team_workflows import workflow_fields
from .workflow_selection import PREDEFINED_WORKFLOWS, predefined_style

FIELDS = frozenset({'name', 'projectId', 'ownerTeamId', 'workflowSteps', 'enabled'})


def team_workflows(team: dict[str, Any]) -> list[dict[str, Any]]:
    """Expose old workflow Teams as one definition without rewriting history."""
    if 'workflows' in team:
        return deepcopy(team['workflows'])
    if 'workflowSteps' not in team:
        return []
    return [{key: deepcopy(team[key]) for key in (
        'id', 'name', 'projectId', 'workflowSteps', 'enabled', 'createdAt', 'updatedAt',
    ) if key in team} | {'teamId': team['id']}]


def workflow_definition(
    team: dict[str, Any], payload: dict[str, Any], *, current: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if set(payload) - FIELDS:
        raise ValueError('workflow_fields_invalid')
    merged = {**(current or {}), **payload}
    name = merged.get('name')
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
        raise ValueError('workflow_name_required')
    if not isinstance(merged.get('enabled', True), bool):
        raise ValueError('workflow_enabled_invalid')
    fields = workflow_fields({
        'projectId': merged.get('projectId'), 'workflowSteps': merged.get('workflowSteps'),
        'memberAgentIds': team.get('memberAgentIds', []),
    }, current=current)
    timestamp = now_iso()
    return {
        **fields, 'id': current['id'] if current else new_database_id(),
        'teamId': team['id'], 'name': name.strip(), 'enabled': merged.get('enabled', True),
        'createdAt': current['createdAt'] if current else timestamp, 'updatedAt': timestamp,
    }


def workflow_execution_snapshot(team: dict[str, Any], workflow_id: str) -> dict[str, Any]:
    """Adapt a definition to the frozen execution contract; never mutate roster."""
    workflow = next((item for item in team_workflows(team) if item['id'] == workflow_id), None)
    if workflow is None:
        raise ValueError('workflow_not_found')
    if not workflow.get('enabled', True):
        raise ValueError('workflow_disabled')
    # A run needs only its participants, not unused specialists in the Team.
    members = list(dict.fromkeys(step['agentId'] for step in workflow['workflowSteps']))
    if not set(members) <= set(team.get('memberAgentIds', [])):
        raise ValueError('team_workflow_assignee_not_member')
    return {
        **{key: deepcopy(value) for key, value in team.items()
           if key not in {'workflows', 'workflowSteps', 'projectId', 'collaborationStyle', 'humanApproval', 'memberConfigs'}},
        **({'ownerTeamId': workflow['ownerTeamId']} if workflow.get('ownerTeamId') else {}),
        'workflowId': workflow['id'], 'workflowKind': 'steps', 'workflowVersion': workflow['updatedAt'],
        'name': workflow['name'], 'projectId': workflow['projectId'],
        'workflowSteps': deepcopy(workflow['workflowSteps']), 'memberAgentIds': members,
        'leadAgentId': team['leadAgentId'] if team.get('leadAgentId') in members else members[0],
    }


def workflow_catalog(team: dict[str, Any]) -> list[dict[str, Any]]:
    return [*deepcopy(PREDEFINED_WORKFLOWS), *[
        {**definition, "kind": "steps"} for definition in team_workflows(team)
    ]]


def validate_default_workflow(team: dict[str, Any], workflow_id: Any) -> str:
    if predefined_style(workflow_id) is not None:
        return str(workflow_id)
    definition = next((item for item in team_workflows(team) if item["id"] == workflow_id), None)
    if definition is None:
        raise ValueError("workflow_not_found")
    if not definition.get("enabled", True):
        raise ValueError("workflow_disabled")
    workflow_execution_snapshot(team, workflow_id)
    return str(workflow_id)


def project_workflow_definition(owner: str, payload: dict[str, Any], *, current: dict[str, Any] | None = None) -> dict[str, Any]:
    """Validate a Project process without borrowing a Team's identity."""
    if set(payload) - FIELDS:
        raise ValueError('workflow_fields_invalid')
    merged = {**(current or {}), **payload}
    steps = merged.get('workflowSteps')
    if not isinstance(steps, list):
        raise ValueError('workflowSteps must contain 1 to 64 steps.')
    members = list(dict.fromkeys(step.get('agentId') for step in steps if isinstance(step, dict) and isinstance(step.get('agentId'), str)))
    project_id = merged.get('projectId')
    owner_team = merged.get('ownerTeamId')
    if bool(project_id) == bool(owner_team):
        raise ValueError('workflow_owner_scope_required')
    fields = workflow_fields({'projectId': project_id or owner_team, 'workflowSteps': steps,
                              'memberAgentIds': members})
    fields['projectId'] = project_id
    if owner_team:
        fields['ownerTeamId'] = owner_team
    if current and (current.get('projectId') != project_id or current.get('ownerTeamId') != owner_team):
        raise ValueError('team_workflow_project_immutable')
    name = merged.get('name')
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
        raise ValueError('workflow_name_required')
    if not isinstance(merged.get('enabled', True), bool):
        raise ValueError('workflow_enabled_invalid')
    timestamp = now_iso()
    return {**fields, 'id': current['id'] if current else new_database_id(), 'ownerUserId': owner,
            'name': name.strip(), 'enabled': merged.get('enabled', True),
            'createdAt': current['createdAt'] if current else timestamp, 'updatedAt': timestamp}


def project_workflow_snapshot(definition: dict[str, Any], project: dict[str, Any], team: dict[str, Any] | None = None) -> dict[str, Any]:
    if not definition.get('enabled', True) or definition.get('deletedAt'):
        raise ValueError('workflow_disabled')
    members = list(dict.fromkeys(step['agentId'] for step in definition['workflowSteps']))
    if team and (not team.get('enabled', True) or team.get('deletedAt') or not set(members) <= set(team.get('memberAgentIds', []))):
        raise ValueError('workflow_team_unavailable')
    return {**deepcopy(definition), 'workflowId': definition['id'], 'workflowKind': 'steps',
            'workflowRecordVersion': 1, 'workflowVersion': definition['updatedAt'],
            'teamId': team['id'] if team else None, 'projectId': project['id'], 'computerId': project['computerId'],
            'memberAgentIds': members}


def snapshot_team_id(snapshot: dict[str, Any]) -> str | None:
    return snapshot.get('teamId') if snapshot.get('workflowRecordVersion') == 1 else snapshot.get('id')
