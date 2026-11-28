"""Per-Project participant selection for Predefined Workflows (pure rules)."""

from __future__ import annotations

from typing import Any

from .workflow_selection import PREDEFINED_WORKFLOWS, predefined_style, require_selectable_workflow

_PRESET_TEMPLATES = frozenset(item["template"] for item in PREDEFINED_WORKFLOWS)
_SAVED_PRESET_TEMPLATES = _PRESET_TEMPLATES | {"pipeline"}


class PredefinedWorkflowChangeError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def apply_workflow_change(
    selections: dict[str, Any] | None, members: list[dict[str, Any]], change: Any
) -> dict[str, dict[str, list[str]]]:
    """Return the selections after one change; `agentIds: null` restores the default."""
    if not isinstance(change, dict) or set(change) != {"workflowId", "agentIds"}:
        raise PredefinedWorkflowChangeError("project_workflow_change_invalid")
    try:
        template = predefined_style(change["workflowId"])
    except ValueError as error:
        raise PredefinedWorkflowChangeError("project_workflow_change_invalid") from error
    if template is None:
        raise PredefinedWorkflowChangeError("project_workflow_change_invalid")
    try:
        require_selectable_workflow(change["workflowId"])
    except ValueError as error:
        raise PredefinedWorkflowChangeError(str(error)) from error

    result = dict(selections or {})
    agent_ids = change["agentIds"]
    if agent_ids is None:
        result.pop(template, None)
        return result
    if not _valid_agent_ids(agent_ids):
        raise PredefinedWorkflowChangeError("project_workflow_change_invalid")
    enabled = {member["agentId"] for member in members if member.get("enabled", True)}
    if not set(agent_ids) <= enabled:
        raise PredefinedWorkflowChangeError("project_workflow_agent_not_member")
    result[template] = {"agentIds": list(agent_ids)}
    return result


def _valid_agent_ids(value: Any) -> bool:
    return (
        isinstance(value, list)
        and bool(value)
        and all(isinstance(item, str) and item for item in value)
        and len(set(value)) == len(value)
    )


def valid_predefined_workflows(value: Any) -> bool:
    return isinstance(value, dict) and all(
        template in _SAVED_PRESET_TEMPLATES
        and isinstance(selection, dict)
        and set(selection) == {"agentIds"}
        and _valid_agent_ids(selection["agentIds"])
        for template, selection in value.items()
    )


def prune_removed_members(
    selections: dict[str, Any] | None, members: list[dict[str, Any]]
) -> dict[str, dict[str, list[str]]]:
    """Drop Agents the roster no longer lists; a disabled member stays selected."""
    listed = {member["agentId"] for member in members}
    pruned: dict[str, dict[str, list[str]]] = {}
    for template, value in (selections or {}).items():
        kept = [agent_id for agent_id in value["agentIds"] if agent_id in listed]
        if kept:
            pruned[template] = {"agentIds": kept}
    return pruned


def selected_agent_ids(project: dict[str, Any], style: str) -> list[str] | None:
    """The owner's selection for a template, or None when every Agent takes part."""
    selection = (project.get("predefinedWorkflows") or {}).get(style)
    return selection["agentIds"] if selection is not None else None
