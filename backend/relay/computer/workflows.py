"""Live validation of a user's Computer-bound, standalone Workflow."""
from copy import deepcopy
from typing import Any

from ..agents.location import agent_placed_on_computer
from ..core.computer_identity import computer_id
from ..core.workflows import workflow_step_agent_ids


def validate_standalone_workflow(
    ctx: Any, definition: dict[str, Any], *, require_enabled: bool = True,
) -> dict[str, Any]:
    if definition.get('projectId') or definition.get('ownerTeamId') or not definition.get('computerId'):
        raise ValueError('workflow_standalone_required')
    if require_enabled and (not definition.get('enabled', True) or definition.get('deletedAt')):
        raise ValueError('workflow_disabled')
    identity, owner = definition['computerId'], definition['ownerUserId']
    nodes = [node for node in ctx.registry.monitor_nodes()
             if computer_id(node) == identity and not node.get('retiredAt') and node.get('status') != 'deleted']
    if not nodes or not any(node.get('userId') == owner for node in nodes):
        raise ValueError('workflow_computer_unavailable')
    node_ids = {node['id'] for node in nodes if node.get('userId') == owner}
    members = workflow_step_agent_ids(definition)
    for member in members:
        agent = ctx.agent_store.get_agent(member)
        if not agent or agent.get('deletedAt') or not agent.get('enabled', True) or agent.get('supervisorUserId') != owner:
            raise ValueError('workflow_agent_unavailable')
        if not agent_placed_on_computer(member, identity, node_ids=node_ids, placement_store=ctx.agent_placement_store):
            raise ValueError('workflow_agent_computer_mismatch')
    return {**deepcopy(definition), 'workflowId': definition['id'], 'workflowKind': 'steps',
            'workflowRecordVersion': 1, 'workflowVersion': definition['updatedAt'],
            'teamId': None, 'projectId': None, 'memberAgentIds': members}
