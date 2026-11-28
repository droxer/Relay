"""Canonical Workflow selection shared by both execution strategies."""
from __future__ import annotations

from typing import Any

PREDEFINED_WORKFLOWS = (
    {'id': 'preset:build_review', 'kind': 'predefined', 'template': 'build_review', 'name': 'Execute and review',
     'enabled': True},
    {'id': 'preset:lead_led', 'kind': 'predefined', 'template': 'lead_led', 'name': 'Lead delegation', 'enabled': True},
)
DEFAULT_WORKFLOW_ID = 'preset:build_review'
RETIRED_WORKFLOW_ID = 'preset:pipeline'
WORKFLOW_RETIRED = 'workflow_retired'


def require_selectable_workflow(workflow_id: Any) -> None:
    """Reject new Pipeline selections while keeping saved references resolvable."""
    if workflow_id == RETIRED_WORKFLOW_ID:
        raise ValueError(WORKFLOW_RETIRED)


def predefined_style(workflow_id: Any) -> str | None:
    if not isinstance(workflow_id, str) or not workflow_id:
        raise ValueError('workflow_id_invalid')
    if workflow_id == RETIRED_WORKFLOW_ID:
        return 'pipeline'
    for definition in PREDEFINED_WORKFLOWS:
        if definition['id'] == workflow_id:
            return str(definition['template'])
    if workflow_id.startswith('preset:'):
        raise ValueError('workflow_not_found')
    return None


def workflow_id_for_style(style: Any) -> str:
    if style in (None, 'solo'):
        return DEFAULT_WORKFLOW_ID
    workflow_id = f'preset:{style}'
    predefined_style(workflow_id)
    return workflow_id


def default_workflow_id(team: dict[str, Any] | None, project_id: str | None = None) -> str:
    team = team or {}
    if project_id and project_id in (team.get('projectWorkflowDefaults') or {}):
        return str(team['projectWorkflowDefaults'][project_id])
    if 'defaultWorkflowId' in team:
        value = team['defaultWorkflowId']
        predefined_style(value)  # Validate reserved ids, without resolving custom scope.
        return str(value)
    if 'workflowSteps' in team or 'projectId' in team:
        return str(team['id'])
    return workflow_id_for_style(team.get('collaborationStyle'))


def selected_workflow_id(team: dict[str, Any] | None, task: dict[str, Any] | None = None) -> str:
    task = task or {}
    if task.get('assignedWorkflowId') is not None:
        value = task['assignedWorkflowId']
        predefined_style(value)
        return str(value)
    if task.get('collaborationStyle') is not None:
        return workflow_id_for_style(task['collaborationStyle'])
    return default_workflow_id(team, task.get("projectId"))


def requested_workflow_style(workflow_id: Any, legacy_style: Any = None) -> str | None:
    """Translate a run selection at the compatibility boundary, fail closed."""
    if workflow_id is None:
        return legacy_style
    style = predefined_style(workflow_id)
    if style is None:
        raise ValueError('workflow_requires_project_runtime')
    if legacy_style is not None and legacy_style != style:
        raise ValueError('workflow_selection_conflict')
    return style
