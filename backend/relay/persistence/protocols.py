from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any, Protocol

from ..core.models import AgentName


@dataclass(frozen=True)
class TaskDispatchAssignment:
    """Task fields that must remain stable between routing and dispatch claim."""

    agent_id: str | None
    team_id: str | None
    project_id: str | None
    user_id: str | None

    @classmethod
    def capture(cls, task: dict[str, Any]) -> TaskDispatchAssignment:
        return cls(
            agent_id=task.get("assignedAgentId"),
            team_id=task.get("assignedTeamId"),
            project_id=task.get("projectId"),
            user_id=task.get("assigneeUserId")
            or task.get("ownerUserId"),
        )

    def matches(self, task: dict[str, Any]) -> bool:
        return self == self.capture(task)


class SessionStore(Protocol):
    def create_session(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def append_event(
        self,
        session_id: str,
        event: dict[str, Any],
        *,
        hydrate_events: bool = True,
    ) -> dict[str, Any]: ...
    def get_session(self, session_id: str) -> dict[str, Any]: ...
    def mutation_scope(self, session_id: str) -> AbstractContextManager[Any]: ...
    def record_runtime_affinity(
        self, session_id: str, computer_id: str
    ) -> dict[str, Any]: ...
    def has_agent_run(self, logical_agent_id: str, placement_ids: set[str]) -> bool: ...
    def get_session_header(self, session_id: str) -> dict[str, Any]: ...
    def session_version(self, session_id: str) -> int: ...
    def run_output_sequences(self, session_id: str, run_id: str) -> dict[str, int]: ...
    def read_event_page(
        self,
        session_id: str,
        *,
        after_event_id: str | None = None,
        after_sequence: int | None = None,
        limit: int = 256,
    ) -> dict[str, Any]: ...
    def delete_session(
        self, session_id: str, *, deleted_by: str | None = None
    ) -> None: ...
    def delete_session_with_task_unlinks(
        self, session_id: str, task_store: Any, *, deleted_by: str | None = None
    ) -> bool: ...
    def list_pending_deletions(self, *, limit: int = 100, offset: int = 0) -> list[dict[str, Any]]: ...
    def list_sessions(self) -> list[dict[str, Any]]: ...
    def list_session_summaries(
        self, *, owner_user_id: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]: ...
    def list_session_snapshots(
        self, *, owner_user_id: str, project_id: str | None = None
    ) -> list[dict[str, Any]]: ...
    def create_artifact(
        self, session_id: str, payload: dict[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any]]: ...
    def write_artifact(
        self, session_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]: ...
    def index_workspace_artifact(
        self, session_id: str, artifact: dict[str, Any], content: bytes | None
    ) -> tuple[dict[str, Any], dict[str, Any]]: ...
    def read_artifact_content(
        self, session_id: str, artifact_id: str
    ) -> bytes | None: ...
    def read_artifact(self, session_id: str, artifact_id: str) -> str: ...
    def list_token_usage(self) -> list[dict[str, Any]]: ...


class TaskStore(Protocol):
    def task_write_scope(self, task_id: str) -> AbstractContextManager[dict[str, Any]]: ...
    def create_task(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def get_task(self, task_id: str) -> dict[str, Any]: ...
    def record_round(
        self,
        task_id: str,
        *,
        round_result: dict[str, Any] | None = None,
        round_count: int | None = None,
        continuation_session_id: str | None = None,
        clear_continuation: bool = False,
        execution_owner: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...
    def list_tasks(
        self, *, user_id: str | None = None, limit: int | None = None
    ) -> list[dict[str, Any]]: ...
    def list_tasks_for_session(self, session_id: str) -> list[dict[str, Any]]: ...
    def list_task_summaries(
        self, *, user_id: str | None = None, limit: int | None = None,
        task_ids: list[str] | None = None
    ) -> list[dict[str, Any]]: ...
    def update_task(
        self,
        task_id: str,
        payload: dict[str, Any],
        *,
        assignment: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...
    def update_task_if_not_dispatching(
        self,
        task_id: str,
        payload: dict[str, Any],
        *,
        assignment: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...
    def delete_task(
        self,
        task_id: str,
        *,
        deleted_by: str | None = None,
        reject_active_claim: bool = False,
        active_linked_session: Callable[[dict[str, Any]], bool] | None = None,
    ) -> dict[str, Any]: ...
    def link_session(self, task_id: str, session_id: str) -> dict[str, Any]: ...
    def unlink_session(self, task_id: str, session_id: str) -> dict[str, Any]: ...
    def set_task_prerequisites(
        self, task_id: str, prerequisite_ids: list[str], *, actor_user_id: str | None = None
    ) -> dict[str, Any]: ...
    def open_prerequisites_for(self, task_ids: list[str]) -> dict[str, list[str]]: ...
    def task_dependents(self, task_id: str) -> list[str]: ...
    def append_event(
        self, task_id: str, event: dict[str, Any], *, execution_owner: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...
    def record_activity(
        self, task_id: str, message: str, payload: dict[str, Any] | None = None,
        *, execution_owner: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...
    def record_dispatch_outcome(
        self,
        task_id: str,
        state: str,
        *,
        code: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]: ...
    def record_dispatch_retry(
        self,
        task_id: str,
        *,
        failure_count: int,
        next_attempt_at: str,
        code: str | None = None,
        message: str | None = None,
    ) -> dict[str, Any]: ...
    def clear_dispatch_retry(self, task_id: str) -> dict[str, Any]: ...
    def claim_task_for_dispatch(
        self,
        task_id: str,
        agent: AgentName,
        message: str | None = None,
        *,
        expected_assignment: TaskDispatchAssignment | None = None,
    ) -> dict[str, Any] | None: ...
    def release_dispatch_claim(self, task_id: str, claim_id: str) -> dict[str, Any]: ...
    def assign_task(
        self, task_id: str, agent: AgentName, agent_id: str | None = None
    ) -> dict[str, Any]: ...
    def set_task_assignment(
        self, task_id: str, agent: AgentName, agent_id: str
    ) -> dict[str, Any]: ...
    def set_task_team_assignment(
        self, task_id: str, team_id: str
    ) -> dict[str, Any]: ...
    def unassign_task(self, task_id: str) -> dict[str, Any]: ...
    def create_triggered_occurrence(
        self,
        routine_id: str,
        *,
        run_date: str,
        trigger_kind: str,
        depth: int,
        context: str,
        summary: dict[str, Any] | None = None,
        allow_paused: bool = False,
    ) -> dict[str, Any] | None: ...
    def list_trigger_automations(self) -> list[dict[str, Any]]: ...


class AgentStore(Protocol):
    def create_agent(
        self, supervisor_user_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]: ...
    def get_agent(self, agent_id: str) -> dict[str, Any] | None: ...
    def list_agents(
        self,
        *,
        supervisor_user_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]: ...
    def update_agent(self, agent_id: str, patch: dict[str, Any]) -> dict[str, Any]: ...
    def transform_skill_policy(
        self,
        agent_id: str,
        transform: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]: ...
    def delete_agent(self, agent_id: str) -> dict[str, Any]: ...
    def ensure_compatibility_agent(
        self,
        supervisor_user_id: str,
        executor_kind: str,
        daemon_node_id: str,
        *,
        computer_id: str | None = None,
    ) -> dict[str, Any]: ...
    def set_birth_certificate(
        self, agent_id: str, *, computer_id: str, default_role: str
    ) -> dict[str, Any]: ...
    def move_to_computer(self, agent_id: str, computer_id: str) -> dict[str, Any]: ...


class AgentPlacementStore(Protocol):
    def get_placement(self, placement_id: str) -> dict[str, Any] | None: ...
    def list_placements(
        self,
        *,
        agent_id: str | None = None,
        daemon_node_id: str | None = None,
        include_removed: bool = False,
    ) -> list[dict[str, Any]]: ...
    def update_placement(
        self, placement_id: str, patch: dict[str, Any]
    ) -> dict[str, Any]: ...
    def rebind_placement(
        self,
        placement_id: str,
        daemon_node_id: str,
        *,
        managed_node_id: str | None = None,
        computer_id_value: str | None = None,
    ) -> dict[str, Any]: ...
    def realize_agent_version(
        self, placement_id: str, agent_version: int
    ) -> dict[str, Any]: ...
    def attach_first_managed_placement(
        self,
        agent: dict[str, Any],
        node: dict[str, Any],
        *,
        expected_placement_ids: set[str],
    ) -> dict[str, Any] | None: ...


class TeamStore(Protocol):
    def create_team(
        self, owner_user_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]: ...
    def get_team(self, team_id: str) -> dict[str, Any] | None: ...
    def list_teams(
        self,
        owner_user_id: str | None = None,
        *,
        include_deleted: bool = False,
    ) -> list[dict[str, Any]]: ...
    def update_team(self, team_id: str, patch: dict[str, Any]) -> dict[str, Any]: ...
    def delete_team(self, team_id: str) -> dict[str, Any]: ...


class ProjectStore(Protocol):
    def create_project(
        self, owner_user_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]: ...
    def get_project(self, project_id: str) -> dict[str, Any] | None: ...
    def list_projects(
        self,
        owner_user_id: str | None = None,
        *,
        include_archived: bool = False,
    ) -> list[dict[str, Any]]: ...
    def update_project(
        self,
        project_id: str,
        patch: dict[str, Any],
        *,
        expected_version: int,
    ) -> dict[str, Any]: ...
    def archive_project(
        self, project_id: str, *, expected_version: int
    ) -> dict[str, Any]: ...
    def unarchive_project(
        self, project_id: str, *, expected_version: int
    ) -> dict[str, Any]: ...
    def record_setup(
        self, project_id: str, setup: dict[str, Any]
    ) -> dict[str, Any]: ...
    def mutate_setup(
        self, project_id: str, change: Callable[[dict[str, Any]], dict[str, Any] | None]
    ) -> dict[str, Any]: ...
    def add_context_suggestions(
        self, project_id: str, merge: Any
    ) -> dict[str, Any]: ...


class AuthStore(Protocol):
    """Accounts, users, departments, and login sessions (``security/auth.py`` and its mixins)."""

    session_ttl_seconds: int

    @property
    def engine(self) -> Any: ...

    def has_accounts(self) -> bool: ...
    def create_account(
        self,
        username: str,
        password: str,
        role: Any = ...,
        email: str | None = ...,
        user_id: str | None = ...,
        display_name: str | None = ...,
        department_id: str | None = ...,
        department_name: str | None = ...,
        max_local_computers: int | None = ...,
    ) -> dict[str, Any]: ...
    def update_user_preferences(
        self,
        account_id: str,
        *,
        theme: Any = ...,
        language: Any = ...,
        onboarding: dict[str, Any] | None = ...,
        home_snoozes: dict[str, Any] | None = ...,
    ) -> dict[str, Any]: ...
    def authenticate(self, username: str, password: str) -> dict[str, Any] | None: ...
    def bootstrap_with_token(
        self, token: str, username: str, password: str
    ) -> dict[str, Any]: ...
    def create_session(self, account_id: str) -> dict[str, Any]: ...
    def get_session_by_token(self, token: str | None) -> dict[str, Any] | None: ...
    def get_account_by_id(self, account_id: str) -> dict[str, Any] | None: ...
    def delete_session(self, token: str) -> bool: ...
    def list_accounts(self) -> list[dict[str, Any]]: ...
    def resolve_user_id(self, user_id: str) -> str: ...
    def ensure_user(
        self,
        user_id: str,
        *,
        display_name: str | None = ...,
        email: str | None = ...,
        department_id: str | None = ...,
        department_name: str | None = ...,
        max_local_computers: int | None = ...,
    ) -> dict[str, Any]: ...
    def update_user(
        self,
        user_id: str,
        *,
        display_name: str | None = ...,
        email: str | None = ...,
        max_local_computers: int | None = ...,
        clear_max_local_computers: bool = ...,
    ) -> dict[str, Any]: ...
    def list_users(self, *, user_ids: list[str] | None = None) -> list[dict[str, Any]]: ...
    def soft_delete_user(self, user_id: str) -> dict[str, Any]: ...
    def ensure_department(
        self,
        department_id: str,
        *,
        name: str | None = ...,
        parent_department_id: str | None = ...,
    ) -> dict[str, Any]: ...
    def list_departments(self) -> list[dict[str, Any]]: ...


class DaemonStore(Protocol):
    def set_command_listener(
        self, listener: Callable[[str], None], *, database_channel: str | None = None
    ) -> None: ...
    def set_workspace_listener(
        self, listener: Callable[[str], None], *, database_channel: str | None = None
    ) -> None: ...
    def request_run_stop(
        self, request_id: str, command_id: str, reason: str,
        *, actor_user_id: str | None = None,
    ) -> dict[str, Any] | None: ...
    def mark_run_request_state(
        self, request_id: str, key: str
    ) -> dict[str, Any] | None: ...
    def claim_pending_node(
        self, node: dict[str, Any]
    ) -> tuple[dict[str, Any], bool]: ...
    def get_node(self, node_id: str) -> dict[str, Any] | None: ...
    def list_nodes(self) -> list[dict[str, Any]]: ...
    def get_command(self, command_id: str) -> dict[str, Any] | None: ...
    def get_commands(self, command_ids: set[str]) -> dict[str, dict[str, Any]]: ...
    def pending_commands_of_type(
        self, node_id: str, command_type: str
    ) -> list[dict[str, Any]]: ...
    def retire_command(self, command_id: str, reason: str) -> bool: ...
    def list_active_runs(
        self, node_id: str | None = None, *, session_ids: set[str] | None = None, limit: int | None = None, after_id: str | None = None
    ) -> list[dict[str, Any]]: ...
    def get_run_request(self, request_id: str) -> dict[str, Any] | None: ...
    def update_run_request_if_status(
        self, request_id: str, expected_status: str, patch: dict[str, Any],
        *, require_undelivered: bool = False,
    ) -> dict[str, Any] | None: ...
    def list_active_run_requests(
        self,
        node_id: str | None = None,
        *,
        session_ids: set[str] | None = None,
        limit: int | None = None,
        after_id: str | None = None,
    ) -> list[dict[str, Any]]: ...
    def historical_managed_node_id(self, runtime_id: str) -> str | None: ...
    def record_workspace_response(
        self, node_id: str, response: dict[str, Any]
    ) -> None: ...
    def get_workspace_response(self, command_id: str) -> dict[str, Any] | None: ...


class ChatStore(Protocol):
    def list_integrations(self) -> list[dict[str, Any]]: ...
    def get_integration(self, integration_id: str) -> dict[str, Any] | None: ...
    def runtime_integrations(self) -> list[dict[str, Any]]: ...


class ManagedNodeStore(Protocol):
    def get_node(self, node_id: str) -> dict[str, Any] | None: ...
    def list_nodes(self) -> list[dict[str, Any]]: ...
    def create_node(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def update_node(self, node_id: str, patch: dict[str, Any]) -> dict[str, Any]: ...


class OrgSettingsStore(Protocol):
    def get_settings(self) -> dict[str, Any]: ...
    def update_settings(
        self,
        *,
        max_local_computers_per_user: int | None = None,
        max_task_rounds: int | None = None,
        skill_import_allowed_hosts: list[str] | None = None,
    ) -> dict[str, Any]: ...


class ProfileImageStore(Protocol):
    def read(self, kind: str, entity_id: str) -> tuple[bytes, str] | None: ...
    def save(
        self, kind: str, entity_id: str, content: bytes, content_type: str
    ) -> dict[str, Any]: ...
    def delete(self, kind: str, entity_id: str) -> bool: ...
