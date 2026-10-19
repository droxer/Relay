"""Closing a thread and settling its task: completion and failure."""

from __future__ import annotations

from typing import Any

from loguru import logger

from ..persistence.session.reducer import INPUT_REQUEST_FIELDS
from ..persistence.task.lifecycle import acceptance_status
from ..persistence.events import relay_event
from .controller_state import SessionControllerState


class SessionCompletionMixin(SessionControllerState):
    def complete_session(
        self, session_id: str, outcome: str, task_status: str = "done",
        *, work_outcome: str = "unverified",
        input_request: dict[str, Any] | None = None,
        accepted_by_human: bool = False,
    ) -> dict[str, Any]:
        """Close the thread and settle its task.

        ``accepted_by_human`` marks a person's own acceptance (mark done): a
        human-acceptance task then closes as done instead of going to review,
        which would ask the same person the same question twice.
        """
        with self._transaction():
            return self._complete_session(
                session_id, outcome, task_status, work_outcome, input_request,
                accepted_by_human=accepted_by_human,
            )

    def repair_completion(
        self, session_id: str, outcome: str, task_status: str = "done",
        *, work_outcome: str = "unverified",
        input_request: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Finish a completion whose session write landed but task write did not.

        A no-op unless the thread is already completed with exactly this
        result: a different completion (a person's mark done, say) is newer
        than the one being retried and must not be overwritten.
        """
        with self._transaction():
            current = self.store.get_session(session_id)
            if not self._completed_with(current, outcome, work_outcome, input_request):
                return current
            return self._complete_session(
                session_id, outcome, task_status, work_outcome, input_request
            )

    @staticmethod
    def _completed_with(
        current: dict[str, Any], outcome: str, work_outcome: str,
        input_request: dict[str, Any] | None,
    ) -> bool:
        request = _session_input_fields(input_request)
        current_request = {
            key: current[key] for key in INPUT_REQUEST_FIELDS if current.get(key)
        }
        return (
            current.get("status") == "completed"
            and current.get("finalOutcome") == outcome
            and current.get("workOutcome") == work_outcome
            and current_request == request
        )

    def _complete_session(
        self, session_id: str, outcome: str, task_status: str = "done",
        work_outcome: str = "unverified",
        input_request: dict[str, Any] | None = None,
        *, accepted_by_human: bool = False,
    ) -> dict[str, Any]:
        # The thread's completion quotes the question; the task keeps the
        # whole wait record (its id and kind too), including on a retry after
        # a partial write.
        request = {key: value for key, value in (input_request or {}).items() if value}
        task_extras = {"sessionId": session_id, **({"request": request} if request else {})}
        current = self.store.get_session(session_id)
        if self._completed_with(current, outcome, work_outcome, request):
            # File-backed stores can persist the session before a task write
            # fails. Repair that write, fenced by this execution's original
            # owner, without duplicating the session event or task transition.
            if self.task_store and self.task_id:
                task = self.task_store.get_task(self.task_id)
                expected = acceptance_status(
                    task, task_status, accepted_by_human=accepted_by_human
                )
                missing_request = expected == "waiting_for_human" and (
                    task.get("waitingSessionId") != session_id
                    or not _same_wait(task.get("waitingRequest"), request)
                )
                if task.get("status") != expected or missing_request:
                    self._update_task_status(
                        task_status, outcome, task_extras,
                        execution_owner=self.task_execution_owner or {
                            "requestId": session_id, "revision": 0,
                        },
                        accepted_by_human=accepted_by_human,
                    )
            return current

        session = self._append(
            session_id,
            relay_event("session.completed", session_id, {
                "outcome": outcome, "workOutcome": work_outcome,
                **_session_input_fields(request),
            }),
        )
        self._update_task_status(
            task_status, outcome, task_extras, accepted_by_human=accepted_by_human,
        )
        logger.info("Session completed", session_id=session_id, outcome=outcome)
        return session

    def fail_session(self, session_id: str, outcome: str) -> dict[str, Any]:
        # A failed task write must not commit just the session transition when
        # both stores share a database. Replay also repairs file-backed partial
        # writes, fenced by the original task execution owner.
        with self._transaction():
            session = self.store.get_session(session_id)
            if session.get("status") != "failed":
                session = self._append(
                    session_id, relay_event("session.failed", session_id, {"outcome": outcome})
                )
            outcome = session.get("finalOutcome") or outcome
            if self.task_store and self.task_id:
                task = self.task_store.get_task(self.task_id)
                # A failed agent run may already have blocked the task with the
                # same words; the closeout still records that the round failed.
                attention = task.get("attention") or {}
                if (task.get("status") != "blocked" or task.get("blockerReason") != outcome
                        or attention.get("code") != "execution_failed"):
                    self._update_task_status("blocked", outcome, {"sessionId": session_id, "code": "execution_failed"})
            logger.info("Session failed", session_id=session_id, outcome=outcome)
            return session


def _session_input_fields(request: dict[str, Any] | None) -> dict[str, Any]:
    """The part of a wait record its thread's completion quotes."""
    return {
        key: value for key, value in (request or {}).items()
        if key in INPUT_REQUEST_FIELDS and value
    }


def _same_wait(recorded: Any, request: dict[str, Any]) -> bool:
    """Whether a task already holds the wait a completion retry would write.

    A request that names its id must match exactly. One that does not had an
    id minted when it was first written, so only its words can be compared.
    """
    if not isinstance(recorded, dict) or not recorded:
        return False
    if request.get("questionId"):
        return recorded == request

    def words(wait: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in wait.items() if key not in ("questionId", "kind")}

    return words(recorded) == words(request)
