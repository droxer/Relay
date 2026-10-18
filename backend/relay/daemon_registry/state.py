"""The state every ``DaemonNodeRegistry`` mixin shares.

The registry is split by concern into mixins (``nodes``, ``node_admin``,
``commands``, ``admission``, ``delivery``, ``progression``, ``completion``,
``events``, ``reaper``). They all act on one in-memory view and one set of
locks, owned and initialized by ``DaemonNodeRegistry.__init__``; this class
only declares that state so each mixin reads as code against a known shape.

Lock order is global then per node: take ``dispatch_lock`` before any
``dispatch_scope`` node lock. Output events take only their node's lock.
"""

from __future__ import annotations

from collections.abc import Callable
from threading import Lock
from contextlib import AbstractContextManager
from typing import TYPE_CHECKING, Any

from ..persistence.protocols import SessionStore, TaskStore
from .locks import GlobalDispatchLock

if TYPE_CHECKING:
    from ..sessions.controller import SessionController


class RegistryState:
    store: SessionStore
    daemon_store: Any
    task_store: TaskStore | None
    project_store: Any
    liveness_timeout_ms: int
    sandboxes: dict[str, dict[str, Any]]
    active_commands: dict[str, dict[str, Any]]
    outputs: dict[str, list[str]]
    output_sizes: dict[str, int]
    output_sequences: dict[str, dict[str, int]]
    output_sequences_hydrated: set[str]
    plain_node_tokens: dict[str, str]
    dispatch_lock: GlobalDispatchLock
    logical_assignment_validator: Callable[[dict[str, Any]], None] | None
    logical_skill_bundle_resolver: (
        Callable[[str, str | None], tuple[dict[str, Any] | None, list[dict[str, Any]]]] | None
    )
    _logged_capacity_waits: set[tuple[str, int]]
    _recovery_lock: Lock
    _last_reap_at: float
    _last_prune_at: float
    _last_seen_persisted_at: dict[str, float]
    _last_progress_persisted_at: dict[str, float]

    if TYPE_CHECKING:
        # Methods one mixin calls on another, declared so each mixin type-checks
        # alone. This list is the registry's internal interface between concerns.
        def _age_ms(self, iso_timestamp: str) -> int:
            ...

        def _assert_authorized(self, sandbox_id: str, token: str | None) -> None:
            ...

        @staticmethod
        def _assignment_reports_round_result(assignments: list[dict[str, Any]], index: int) -> bool:
            ...

        def _cancel_active_run_unlocked(self, sandbox_id: str, session_id: str, reason: str, *, actor_user_id: str | None=None) -> dict[str, Any] | None:
            ...

        def _claim_and_advance_run_request(self, event: dict[str, Any]) -> bool:
            ...

        def _complete_run_request(self, run_request: dict[str, Any], outcome: str) -> None:
            ...

        def _controller_for_sandbox(self, sandbox: dict[str, Any], task_id: str | None=None, run_request: dict[str, Any] | None=None) -> SessionController:
            ...

        def _enqueue_current_assignment(self, run_request: dict[str, Any], *, active_runs: list[dict[str, Any]] | None=None, validate_logical_assignment: bool=True) -> dict[str, Any]:
            ...

        def _ensure_agent_started_for_command(self, run_request: dict[str, Any], command: dict[str, Any]) -> None:
            ...

        def _fail_run_request(self, run_request: dict[str, Any], outcome: str, *, delivery_never_sent: bool=False) -> None:
            ...

        @staticmethod
        def _follow_up_backing_off(run_request: dict[str, Any]) -> bool:
            ...

        def _follow_up_run_request(self, run_request: dict[str, Any], outcome: str='Assignments completed.') -> None:
            ...

        def _hydrate_node(self, sandbox_id: str) -> None:
            ...

        def _linked_workspace_path(self, session: dict[str, Any]) -> str | None:
            ...

        def _live_node(self, sandbox_id: str) -> dict[str, Any] | None:
            ...

        def _liveness(self, sandbox: dict[str, Any]) -> dict[str, Any]:
            ...

        def _mark_seen(self, sandbox_id: str) -> None:
            ...

        def _note_run_progress(self, command: dict[str, Any]) -> None:
            ...

        def _record_exit_unconfirmed(self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any]) -> None:
            ...

        def _record_follow_up_failure(self, run_request: dict[str, Any], error: Exception) -> None:
            ...

        def _record_generated_workspace_artifacts(self, sandbox: dict[str, Any], run_request: dict[str, Any], event: dict[str, Any], artifact_snapshot: dict[str, Any] | None, assignment: dict[str, Any] | None=None) -> None:
            ...

        def _record_handoff_delivery(self, command: dict[str, Any], status: str) -> None:
            ...

        def _record_permission_request(self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any]) -> None:
            ...

        def _record_skipped_skills(self, command: dict[str, Any], daemon_skips: Any) -> None:
            ...

        def _refresh_persisted_liveness(self, sandbox_id: str | None=None) -> None:
            ...

        def _remember_control_panel_node_token(self, sandbox: dict[str, Any], token: str | None) -> None:
            ...

        @staticmethod
        def _round_result(event: dict[str, Any]) -> dict[str, Any] | None:
            ...

        def _round_result_was_required(self, run_request: dict[str, Any]) -> bool:
            ...

        def _run_request_command_link(self, command: dict[str, Any]) -> dict[str, Any]:
            ...

        def _track_active_command(self, sandbox_id: str, command: dict[str, Any]) -> None:
            ...

        def activate_run_request(self, request_id: str, *, task_goal: str | None=None, active_runs: list[dict[str, Any]] | None=None) -> dict[str, Any]:
            ...

        def cancel_active_run(self, sandbox_id: str, session_id: str, reason: str, *, actor_user_id: str | None=None) -> dict[str, Any] | None:
            ...

        def cancel_run_request_before_delivery(self, request_id: str, reason: str) -> dict[str, Any] | None:
            ...

        def clear_run_output(self, run_id: str) -> None:
            ...

        def computer_node_records(self, computer: str) -> list[dict[str, Any]]:
            ...

        def dispatch_scope(self, node_ids: list[str]) -> AbstractContextManager[None]:
            ...

        def enqueue(self, sandbox_id: str, command: dict[str, Any]) -> None:
            ...

        def find_by_user(self, user_id: str, workspace_path: str | None=None) -> dict[str, Any] | None:
            ...

        def monitor_nodes(self) -> list[dict[str, Any]]:
            ...

        def output_for_run(self, run_id: str) -> str:
            ...

        def reap_stale_runs(self, *, force: bool=True) -> None:
            ...

        def rehome_workspace_cleanups(self, computer: str, target_id: str) -> int:
            ...

        def update_status(self, sandbox_id: str, patch: dict[str, Any]) -> None:
            ...
