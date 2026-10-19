"""Retrying a round's follow-up assignment that failed to start, and closing a thread superseded by a newer execution.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

from datetime import datetime, timedelta, UTC
from typing import Any
from loguru import logger
from ...core.computer_identity import computer_id
from ...persistence.tables.daemon import ACTIVE_RUN_REQUEST_STATUSES
from ...persistence.task.execution import request_execution_owner
from ...sessions.controller import SessionController
from .. import config
from ..records import (
    FOLLOW_UP_FAILURE_STATE_KEY,
)
from ..state import RegistryState


class FollowUpRetryMixin(RegistryState):
    def _close_superseded_thread(self, session_id: str) -> None:
        """Close a thread whose round lost its task to a newer execution.

        With no other request active the thread would read `running` forever.
        The controller carries no task: the task belongs to its new owner.
        """
        if self.daemon_store.active_run_request_for_session_any_node(session_id):
            return
        if self.store.get_session(session_id).get("status") != "running":
            return
        # Not a cancel: that is a human decision and must name its actor.
        SessionController(self.store).fail_session(
            session_id, "This round stopped because its task moved to another run."
        )

    def _follow_up_run_request(
        self, run_request: dict[str, Any], outcome: str = "Assignments completed."
    ) -> None:
        """Start the request's current assignment, or close the round past its end.

        Runs after finalization has released its terminal claim, so a failure
        here is outside that claim's attempt counting. Count it on the request
        instead: a deterministic error used to leave the thread `running` with
        the reaper retrying forever and nothing visible to anyone.
        """
        try:
            if run_request.get("currentIndex", 0) >= len(run_request["assignments"]):
                self._complete_run_request(run_request, outcome)
            else:
                self._enqueue_current_assignment(run_request)
        except Exception as error:
            # Record before re-raising: the caller's own handling (the claim
            # handler, the reaper's log) cannot count it.
            self._record_follow_up_failure(run_request, error)
            raise

    @staticmethod
    def _follow_up_backing_off(run_request: dict[str, Any]) -> bool:
        failure = (run_request.get("state") or {}).get(FOLLOW_UP_FAILURE_STATE_KEY)
        if not isinstance(failure, dict) or failure.get("index") != run_request.get("currentIndex", 0):
            return False
        retry_at = failure.get("retryAt")
        return isinstance(retry_at, str) and datetime.fromisoformat(retry_at) > datetime.now(UTC)

    def _record_follow_up_failure(self, run_request: dict[str, Any], error: Exception) -> None:
        logger.exception(
            "Could not continue a run request after finalization",
            run_request_id=run_request["id"],
            session_id=run_request.get("sessionId"),
            current_index=run_request.get("currentIndex", 0),
        )
        current = self.daemon_store.get_run_request(run_request["id"])
        if not current or current.get("status") not in ACTIVE_RUN_REQUEST_STATUSES:
            return
        index = current.get("currentIndex", 0)
        state = dict(current.get("state") or {})
        previous = state.get(FOLLOW_UP_FAILURE_STATE_KEY)
        attempts = (
            int(previous.get("attempts") or 0)
            if isinstance(previous, dict) and previous.get("index") == index
            else 0
        ) + 1
        if attempts >= config.MAX_FOLLOW_UP_ATTEMPTS:
            try:
                self._fail_run_request(
                    current,
                    f"The round could not continue after {attempts} attempts: {str(error)[:500]}",
                )
            except Exception:  # noqa: BLE001 - nothing more to do than report it
                logger.exception(
                    "Could not fail a run request that cannot continue",
                    run_request_id=current["id"],
                )
            return
        # A transient error retries on the next recovery pass; a repeating one
        # backs off until the cap fails the thread.
        retry_at = datetime.now(UTC) + timedelta(
            seconds=0 if attempts == 1 else min(300, 5 * 2 ** (attempts - 2))
        )
        state[FOLLOW_UP_FAILURE_STATE_KEY] = {
            "index": index,
            "attempts": attempts,
            "retryAt": retry_at.isoformat(),
            "error": str(error)[:500],
        }
        self.daemon_store.update_run_request_if_status(
            current["id"], current["status"], {"state": state}
        )

    def _controller_for_sandbox(
        self, sandbox: dict[str, Any], task_id: str | None = None,
        run_request: dict[str, Any] | None = None,
    ) -> SessionController:

        return SessionController(
            self.store,
            task_store=self.task_store,
            task_id=task_id,
            task_execution_owner=request_execution_owner(run_request) if run_request else None,
            workspace_path=sandbox.get("workspacePath") or "/workspace",
            owner_user_id=sandbox.get("userId"),
            daemon_node_id=sandbox.get("id"),
            managed_node_id=sandbox.get("managedNodeId"),
            computer_id=computer_id(sandbox),
        )
