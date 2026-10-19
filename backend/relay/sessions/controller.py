"""``SessionController``: every mutation of a thread (session) and its task.

The class is assembled from one mixin per concern (see ``controller_state.py``):
``lifecycle`` (create, reopen, rename, archive, delete), ``messages`` (user
messages, room participants), ``agent_runs`` (round plans and agent runs),
``completion`` (complete, fail), ``decisions`` (human decisions, permission
answers), and ``assignment`` (assignments, handoff, artifacts). This module
owns construction only.
"""

from __future__ import annotations

from typing import Any

from ..persistence.protocols import SessionStore, TaskStore
from .agent_runs import SessionAgentRunMixin
from .assignment import SessionAssignmentMixin
from .completion import SessionCompletionMixin
from .decisions import SessionDecisionMixin
from .lifecycle import SessionLifecycleMixin
from .messages import SessionMessageMixin


class SessionController(
    SessionLifecycleMixin,
    SessionMessageMixin,
    SessionAgentRunMixin,
    SessionCompletionMixin,
    SessionDecisionMixin,
    SessionAssignmentMixin,
):
    def __init__(
        self,
        store: SessionStore,
        *,
        task_store: TaskStore | None = None,
        task_id: str | None = None,
        task_execution_owner: dict[str, Any] | None = None,
        workspace_path: str = "/workspace",
        owner_user_id: str | None = None,
        owner_agent_id: str | None = None,
        team_id: str | None = None,
        project_id: str | None = None,
        workspace_layout: str | None = None,
        workspace_subpath: str | None = None,
        daemon_node_id: str | None = None,
        managed_node_id: str | None = None,
        computer_id: str | None = None,
    ):
        self.store = store
        self.task_store = task_store
        self.task_id = task_id
        self.task_execution_owner = task_execution_owner
        self.workspace_path = workspace_path
        self.owner_user_id = owner_user_id
        self.owner_agent_id = owner_agent_id
        self.team_id = team_id
        self.project_id = project_id
        self.workspace_layout = workspace_layout
        self.workspace_subpath = workspace_subpath
        self.daemon_node_id = daemon_node_id
        self.managed_node_id = managed_node_id
        self.computer_id = computer_id
        self.active_session_id = ""
