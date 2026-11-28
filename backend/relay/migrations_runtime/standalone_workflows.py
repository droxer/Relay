"""Backfill Computer-scoped Workflows and future Task assignments."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from loguru import logger

from ..agents.location import agent_computer_ids
from ..collaboration.contracts import member_configs, text_list
from ..computer.workflows import validate_standalone_workflow
from ..core.computer_identity import computer_id
from ..core.ids import now_iso
from ..core.workflow_selection import (
    PREDEFINED_WORKFLOWS, default_workflow_id, predefined_style, require_selectable_workflow, selected_workflow_id,
)
from ..core.team_workflows import normalize_workflow_steps
from ..core.workflows import project_workflow_definition
from ..persistence.events import relay_task_event
from ..persistence.resource_lock import resource_transaction
from ..persistence.task.rules import compact_task_writes
from ..tasks.claims import dispatch_claim_active
from ..tasks.workspace import recorded_task_workspace


@dataclass(frozen=True)
class LegacyWorkflowMigration:
    team_store: Any
    task_store: Any
    agent_store: Any
    agent_placement_store: Any
    registry: Any

    def run(self) -> set[str]:
        nodes = self.registry.monitor_nodes()
        nodes_by_id = {node['id']: node for node in nodes}
        targets: dict[str, dict[str, dict[str, Any] | str]] = {}
        skipped_teams: dict[str, str] = {}
        candidates = self.task_store.legacy_standalone_team_task_assignments()
        selections: dict[str, list[dict[str, Any]]] = {}
        for candidate in candidates:
            selections.setdefault(candidate['assignedTeamId'], []).append(candidate)
        store = self.team_store.workflow_store
        for candidate in self.team_store.list_teams():
            if candidate.get('projectId'):
                continue
            team_id = candidate['id']
            with resource_transaction(store.engine, f'workflows:{team_id}'):
                team = self.team_store.get_team(team_id)
                if team and not team.get('projectId') and not team.get('deletedAt'):
                    try:
                        owner, identity = self._team_scope(team, nodes_by_id)
                    except ValueError as error:
                        skipped_teams[team_id] = str(error)
                        _skip('team', team_id, str(error))
                        continue
                    targets[team_id] = self._migrate_team(team, owner, identity, selections.get(team_id, []))

        for candidate in candidates:
            task_id = candidate['id']
            with compact_task_writes(), self.task_store.task_write_scope(task_id) as task:
                team_id = task.get('assignedTeamId')
                if task.get('projectId') or task.get('deletedAt') or not team_id:
                    continue
                try:
                    if team_id in skipped_teams:
                        raise ValueError(skipped_teams[team_id])
                    self._migrate_task(task, targets, nodes)
                except ValueError as error:
                    _skip('task', task_id, str(error), team_id=team_id)

        return set(skipped_teams)

    def _migrate_team(
        self, team: dict[str, Any], owner: str, identity: str, tasks: list[dict[str, Any]],
    ) -> dict[str, dict[str, Any] | str]:
        team_id = team['id']
        store = self.team_store.workflow_store
        definitions = {item['id']: item for item in store.list_workflows(owner_team_id=team_id)}
        try:
            default = default_workflow_id(team)
        except ValueError as error:
            _skip('team_default', team_id, str(error))
            default = None
        selections = dict.fromkeys([*([default] if default else []), *definitions])
        # Materialize explicit predefined overrides only where a standalone
        # Task actually selects them. The default is migrated even without Tasks.
        for task in tasks:
            if task['ownerUserId'] != owner or task['assigneeUserId'] not in (None, owner):
                continue
            try:
                source_id = selected_workflow_id(team, task)
                if predefined_style(source_id) is not None:
                    selections.setdefault(source_id)
            except ValueError:
                continue  # Report the invalid selection with the Task's id below.

        results: dict[str, dict[str, Any] | str] = {}
        for source_id in selections:
            try:
                require_selectable_workflow(source_id)
                style = predefined_style(source_id)
                source = definitions.get(source_id)
                if not style and not source:
                    raise ValueError('workflow_not_standalone_team_owned')
                if source and (source.get('projectId') or source.get('computerId')
                               or source.get('ownerTeamId') != team_id or source['ownerUserId'] != owner):
                    raise ValueError('workflow_scope_mismatch')
                if source and not source.get('enabled', True):
                    raise ValueError('workflow_disabled')
                target = self._definition(team, owner, identity, source_id, source, style, source_id == default)
                validate_standalone_workflow(self, target)
                results[source_id] = store.import_standalone_workflow(
                    target, alternate_id=_copied_id(team_id, source_id),
                )
            except ValueError as error:
                results[source_id] = str(error)
                _skip('team_default' if source_id == default else 'workflow', source_id, str(error), team_id=team_id)
        return results

    def _team_scope(self, team: dict[str, Any], nodes: dict[str, Any]) -> tuple[str, str]:
        if not team.get('enabled', True):
            raise ValueError('team_disabled')
        if 'workflowSteps' in team:
            raise ValueError('team_project_scope_invalid')
        owner = team.get('ownerUserId')
        members = team.get('memberAgentIds')
        if (not isinstance(owner, str) or not owner or not isinstance(members, list) or not members
                or any(not isinstance(member, str) or not member for member in members)
                or len(set(members)) != len(members) or team.get('leadAgentId') not in members):
            raise ValueError('team_roster_invalid')
        roster_computers = []
        for member in members:
            agent = self.agent_store.get_agent(member)
            if (not agent or agent.get('deletedAt') or not agent.get('enabled', True)
                    or agent.get('supervisorUserId') != owner):
                raise ValueError('workflow_agent_unavailable')
            computers = agent_computer_ids(
                agent, placement_store=self.agent_placement_store, nodes_by_id=nodes,
            )
            if len(computers) != 1:
                raise ValueError('workflow_agent_computer_ambiguous' if computers else 'workflow_computer_unavailable')
            roster_computers.append(computers.pop())
        if len(set(roster_computers)) != 1:
            raise ValueError('workflow_agent_computer_mismatch')
        identity = roster_computers[0]
        if team.get('computerId') and team['computerId'] != identity:
            raise ValueError('workflow_computer_mismatch')
        if not any(computer_id(node) == identity and node.get('userId') == owner
                   and not node.get('retiredAt') and node.get('status') != 'deleted' for node in nodes.values()):
            raise ValueError('workflow_computer_unavailable')
        return owner, identity

    @staticmethod
    def _definition(
        team: dict[str, Any], owner: str, identity: str, source_id: str,
        source: dict[str, Any] | None, style: str | None, is_default: bool,
    ) -> dict[str, Any]:
        team_id = team['id']
        if source:
            steps = normalize_workflow_steps(source.get('workflowSteps'), team['memberAgentIds'])
            definition = project_workflow_definition(owner, {
                'name': source.get('name'), 'computerId': identity, 'workflowSteps': steps,
            })
        else:
            preset_name = next(item['name'] for item in PREDEFINED_WORKFLOWS if item['id'] == source_id)
            approval = team.get('humanApproval', False)
            if not isinstance(approval, bool):
                raise ValueError('workflow_approval_policy_invalid')
            definition = {
                'name': team['name'] if is_default else f"{team['name']} · {preset_name}",
                'ownerUserId': owner, 'computerId': identity, 'projectId': None, 'enabled': True,
                'workflowSteps': [], 'kind': 'predefined', 'updatedAt': now_iso(),
                'predefined': {
                    'template': style,
                    'memberAgentIds': team['memberAgentIds'],
                    'leadAgentId': team['leadAgentId'],
                    'memberConfigs': member_configs(team.get('memberConfigs', {}), team['memberAgentIds']),
                    'acceptanceCriteria': text_list(team.get('acceptanceCriteria', []), 'acceptanceCriteria'),
                    'humanApproval': approval,
                },
            }
        original = source or team
        return {
            **definition, 'id': team_id if is_default else _copied_id(team_id, source_id),
            'createdAt': original['createdAt'],
            'legacyTeamId': team_id, 'legacyWorkflowId': source_id,
        }

    def _migrate_task(
        self, task: dict[str, Any], targets: dict[str, dict[str, dict[str, Any] | str]],
        nodes: list[dict[str, Any]],
    ) -> None:
        team_id = task['assignedTeamId']
        team = self.team_store.get_team(team_id)
        if not team or team.get('deletedAt'):
            raise ValueError('team_not_found')
        if team.get('projectId'):
            raise ValueError('team_project_scope')
        if not team.get('enabled', True):
            raise ValueError('team_disabled')
        if (not task.get('ownerUserId') or team.get('ownerUserId') != task['ownerUserId']
                or task.get('assigneeUserId') not in (None, task['ownerUserId'])):
            raise ValueError('workflow_owner_required')
        source_id = selected_workflow_id(team, task)
        target = targets.get(team_id, {}).get(source_id)
        if target is None:
            raise ValueError('workflow_migration_target_unavailable' if predefined_style(source_id)
                             else 'workflow_not_standalone_team_owned')
        if isinstance(target, str):
            raise ValueError(target)
        if task.get('assignedAgentId') or task.get('assignedAgent'):
            raise ValueError('workflow_assignment_conflict')
        if dispatch_claim_active(task):
            raise ValueError('task_dispatch_in_progress')
        active = self.registry.daemon_store.active_run_request_for_task(task['id'])
        # Older dedicated Workflow steps still check Task scope at gates.
        # Ordinary Team rounds consume the frozen manifest and execution owner.
        if active and target.get('kind') != 'predefined':
            raise ValueError('task_workflow_in_progress')
        identity = target['computerId']
        binding = recorded_task_workspace(task, self.registry.store, nodes)
        if ((binding and not binding.get('unbound') and binding.get('computerId') != identity)
                or task.get('computerId') not in (None, identity)):
            raise ValueError('workflow_computer_mismatch')
        self.task_store.append_events(task['id'], [
            relay_task_event('task.updated', task['id'], {'computerId': identity, 'collaborationStyle': ''}),
            relay_task_event('task.assigned', task['id'], {
                'workflowId': target['id'], 'legacyTeamId': team_id, 'legacyWorkflowId': source_id,
            }),
        ])


def _copied_id(team_id: str, source_id: str) -> str:
    return str(uuid5(NAMESPACE_URL, f'relay.standalone-workflow.v1:{team_id}:{source_id}'))


def _skip(kind: str, record_id: str, reason: str, **fields: Any) -> None:
    logger.warning(
        'Skipped legacy standalone Workflow migration for {record_kind} {record_id}: {reason}',
        record_kind=kind, record_id=record_id, reason=reason, **fields,
    )
