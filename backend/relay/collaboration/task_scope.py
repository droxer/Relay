"""Which task a round executes for, and the human wait an answer resumes."""

from __future__ import annotations

from typing import Any

from .errors import CollaborationError
from .intake import _PreparedRound
from .state import ConductorState


class TaskScopeMixin(ConductorState):
    def _round_work_scope(
        self,
        intent: _PreparedRound,
        session: dict[str, Any] | None,
        is_recovery: bool,
        answered_task: dict[str, Any] | None,
    ) -> tuple[str | None, dict[str, Any]]:
        """The task this round executes for, and the manifest fields naming it."""
        if session and is_recovery:
            ownership = {
                "revision": session.get("collaborationRevision", 0),
                "roundId": session.get("activeRoundId"),
            }
            scope = self._recovery_work_scope(session)
            if scope["kind"] != "task":
                return None, {"sourceOwnership": ownership, "workScope": scope}
            task = self.ctx.task_store.get_task(scope["taskId"])
            return scope["taskId"], {
                "sourceOwnership": ownership,
                "sourceTaskRevision": _execution_revision(task),
                "workScope": scope,
            }
        if session and intent.source == "message" and intent.purpose == "accomplish":
            # A reply to a task that is waiting on its human is the answer the
            # task asked for: run it as the task's next round, so the verdict
            # moves the task instead of leaving it parked forever. Discussion
            # and review messages keep their conversational scope.
            # An answer resumes exactly the task its question was checked
            # against; one read, so the check and the resume cannot disagree.
            task = answered_task or self._awaiting_task(session)
            if task:
                return task["id"], {
                    "sourceTaskRevision": _execution_revision(task),
                    "workScope": {"kind": "task", "taskId": task["id"]},
                }
        return None, {}

    def _assert_current_question(
        self, session: dict[str, Any] | None, question_id: str
    ) -> dict[str, Any]:
        """Refuse an answer to a question the thread no longer waits on.

        Matching an answer by thread and task status alone let a stale reply
        (a second tab, a double send across a quick round) answer whatever the
        task asked next. Naming the question closes that.
        """
        task = self._awaiting_task(session) if session else None
        current = ((task or {}).get("waitingRequest") or {}).get("questionId")
        if task is None or current != question_id:
            raise CollaborationError(
                "question_superseded",
                "This question was already answered or replaced. "
                "Reload the thread to see what it waits on now.",
            )
        return task

    def _awaiting_task(self, session: dict[str, Any]) -> dict[str, Any] | None:
        """The task waiting on this thread's human, if a reply here resumes it.

        A wait that records its thread (`waitingSessionId`) names the room
        outright, so a status question asked in between does not orphan it.
        Older waits fall back to the active round's task scope, and a task now
        waiting in another thread never answers to this one.
        """
        session_id = session.get("id")
        for task in self.ctx.task_store.list_tasks_for_session(session_id):
            if task.get("waitingSessionId") == session_id and _resumable_wait(task):
                return task
        source_round: dict[str, Any] = next(
            (
                item
                for item in session.get("collaborationRounds", [])
                if item.get("roundId") == session.get("activeRoundId")
            ),
            {},
        )
        scope = source_round.get("workScope")
        if not (
            isinstance(scope, dict)
            and scope.get("kind") == "task"
            and isinstance(scope.get("taskId"), str)
            and scope["taskId"]
        ):
            return None
        try:
            task = self.ctx.task_store.get_task(scope["taskId"])
        except KeyError:
            return None
        if not _resumable_wait(task):
            return None
        waiting_session_id = task.get("waitingSessionId")
        if waiting_session_id and waiting_session_id != session_id:
            return None
        return task

    def _recovery_work_scope(self, session: dict[str, Any]) -> dict[str, str]:
        source_round: dict[str, Any] = next(
            (
                item
                for item in session.get("collaborationRounds", [])
                if item.get("roundId") == session.get("activeRoundId")
            ),
            {},
        )
        scope = source_round.get("workScope")
        if scope is None:
            # Historical links cannot establish execution ownership.
            if any(
                not task.get("isRoutine")
                for task in self.ctx.task_store.list_tasks_for_session(session["id"])
            ):
                raise CollaborationError(
                    "work_scope_required",
                    "This legacy thread has no recorded work scope. Restart from the task to establish task ownership.",
                )
            return {"kind": "thread"}
        if scope == {"kind": "thread"}:
            return {"kind": "thread"}
        if not (
            isinstance(scope, dict)
            and scope.get("kind") == "task"
            and isinstance(scope.get("taskId"), str)
            and scope["taskId"]
        ):
            raise CollaborationError(
                "work_scope_invalid",
                "The source round has an unsupported work scope.",
            )
        try:
            task = self.ctx.task_store.get_task(scope["taskId"])
        except KeyError:
            task = None
        if not task or task.get("deletedAt") or task.get("isRoutine"):
            raise CollaborationError(
                "task_unavailable",
                "The source task is unavailable for recovery.",
            )
        return {"kind": "task", "taskId": scope["taskId"]}


def _resumable_wait(task: dict[str, Any]) -> bool:
    return (
        not task.get("deletedAt")
        and not task.get("isRoutine")
        and task.get("status") == "waiting_for_human"
    )


def _execution_revision(task: dict[str, Any]) -> Any:
    return (task.get("executionOwner") or {}).get("revision", 0)
