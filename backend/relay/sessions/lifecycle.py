"""Creating, reopening, renaming, archiving, and deleting a thread."""

from __future__ import annotations

from typing import Any

from loguru import logger

from ..collaboration.models import COLLABORATION_ADMISSION_EXPIRED_OUTCOME
from ..persistence.events import relay_event
from .controller_state import SessionControllerState
from .errors import SessionRunInFlightError


class SessionLifecycleMixin(SessionControllerState):
    def create_session(
        self,
        task_goal: str,
        participants: list[str] | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        session = self.store.create_session(
            {
                **({"id": session_id} if session_id else {}),
                "workspacePath": self.workspace_path,
                **(
                    {"ownerUserId": self.owner_user_id}
                    if self.owner_user_id
                    else {}
                ),
                **(
                    {"ownerAgentId": self.owner_agent_id} if self.owner_agent_id else {}
                ),
                **({"teamId": self.team_id} if self.team_id else {}),
                **({"projectId": self.project_id} if self.project_id else {}),
                **(
                    {"workspaceLayout": self.workspace_layout}
                    if self.workspace_layout
                    else {}
                ),
                **(
                    {"workspaceSubpath": self.workspace_subpath}
                    if self.workspace_subpath
                    else {}
                ),
                **(
                    {"daemonNodeId": self.daemon_node_id} if self.daemon_node_id else {}
                ),
                **(
                    {"managedNodeId": self.managed_node_id}
                    if self.managed_node_id
                    else {}
                ),
                **({"computerId": self.computer_id} if self.computer_id else {}),
                "taskGoal": task_goal,
                "participants": participants or ["human"],
                "status": "running",
            }
        )
        self.active_session_id = session["id"]
        self._link_task_session(session["id"])
        logger.info(
            "Session created",
            session_id=session["id"],
            workspace_path=self.workspace_path,
            owner=self.owner_user_id,
        )
        return session

    def reopen_expired_admission(self, session_id: str) -> dict[str, Any]:
        """Authoritatively reopen only a session failed by admission expiry."""
        current = self.store.get_session(session_id)
        if current.get("status") == "running" and not current.get("finalOutcome"):
            return current
        if not (
            current.get("status") == "failed"
            and current.get("finalOutcome") == COLLABORATION_ADMISSION_EXPIRED_OUTCOME
        ):
            raise ValueError(
                f"Cannot reopen terminal session {session_id} after collaboration admission expiry."
            )
        session = self._append(
            session_id,
            relay_event(
                "session.status",
                session_id,
                {"status": "running", "phase": "admission:retry"},
            ),
        )
        self._update_task_status(
            "running",
            "Collaboration admission retry started.",
            {"sessionId": session_id},
        )
        return session

    def continue_session(self, session_id: str) -> dict[str, Any]:
        """Reopen a terminal thread because a new user contribution was accepted."""
        current = self.store.get_session(session_id)
        if current.get("status") not in ("completed", "failed", "cancelled"):
            return current
        return self._append(
            session_id,
            relay_event(
                "session.status",
                session_id,
                {"status": "running", "phase": "continued"},
            ),
        )

    def archive_session(self, session_id: str) -> dict[str, Any]:
        snapshot = self.store.get_session(session_id)
        if snapshot.get("archived"):
            return snapshot
        self._append(session_id, relay_event("session.archived", session_id, {}))
        logger.info("Session archived", session_id=session_id)
        return self.store.get_session(session_id)

    def record_runtime_affinity(
        self, session_id: str, computer_id: str
    ) -> dict[str, Any]:
        """Pin the thread to one Computer. Written once, never rewritten."""
        return self.store.record_runtime_affinity(session_id, computer_id)

    def delete_session(
        self,
        session_id: str,
        snapshot: dict[str, Any] | None = None,
        *,
        deleted_by: str | None = None,
    ) -> None:
        if snapshot is None:
            snapshot = self.store.get_session(session_id)
        if snapshot.get("status") != "cancelled" and any(
            run.get("status") == "running" for run in snapshot.get("agentRuns", [])
        ):
            raise SessionRunInFlightError(session_id)
        if self.task_store:
            # One transaction unlinks the thread from its tasks, deletes any
            # task it orphans, and deletes the thread.
            if not self.store.delete_session_with_task_unlinks(
                session_id, self.task_store, deleted_by=deleted_by
            ):
                raise SessionRunInFlightError(session_id)
            logger.info("Session deleted", session_id=session_id)
            return
        self.store.delete_session(session_id, deleted_by=deleted_by)
        logger.info("Session deleted", session_id=session_id)

    def rename_session(self, session_id: str, title: str) -> dict[str, Any]:
        snapshot = self.store.get_session(session_id)
        if snapshot.get("title") == title:
            return snapshot
        session = self._append(
            session_id, relay_event("session.renamed", session_id, {"title": title})
        )
        logger.info("Session renamed", session_id=session_id, title=title)
        return session
