"""The state every ``SessionController`` mixin shares.

The controller is split by concern into mixins (``lifecycle``, ``messages``,
``agent_runs``, ``completion``, ``decisions``, ``assignment``). They all act
on one session store, optional task store, and the task execution they speak
for, initialized by ``SessionController.__init__``; this class declares that
state and owns the event-append and task-status plumbing every mixin uses.
"""

from __future__ import annotations

from contextlib import AbstractContextManager, nullcontext
from typing import TYPE_CHECKING, Any

from ..core.human_waits import ensure_wait_record
from ..persistence.protocols import SessionStore, TaskStore
from ..persistence.engine import store_transaction
from ..persistence.task.lifecycle import acceptance_status
from ..persistence.events import relay_task_event


class SessionControllerState:
    store: SessionStore
    task_store: TaskStore | None
    task_id: str | None
    task_execution_owner: dict[str, Any] | None
    workspace_path: str
    owner_user_id: str | None
    owner_agent_id: str | None
    team_id: str | None
    project_id: str | None
    workspace_layout: str | None
    workspace_subpath: str | None
    daemon_node_id: str | None
    managed_node_id: str | None
    computer_id: str | None
    active_session_id: str

    if TYPE_CHECKING:
        # Methods one mixin calls on another, declared so each type-checks alone.
        def complete_session(
            self, session_id: str, outcome: str, task_status: str = "done",
            *, work_outcome: str = "unverified",
            input_request: dict[str, Any] | None = None,
            accepted_by_human: bool = False,
        ) -> dict[str, Any]:
            ...

        def cancel_session(
            self, session_id: str, note: str = "Cancelled by human.",
            *, actor_user_id: str | None = None,
        ) -> dict[str, Any]:
            ...

    def _append(
        self, session_id: str, event: dict[str, Any], *, hydrate: bool = True
    ) -> dict[str, Any]:
        """Append one event. Pass ``hydrate=False`` when the result is not
        read: hydrating replays the whole event log for the return value."""
        return self.store.append_event(session_id, event, hydrate_events=hydrate)

    def _link_task_session(self, session_id: str) -> None:
        if not self.task_store or not self.task_id:
            return
        task = self.task_store.get_task(self.task_id)
        if session_id not in task["linkedSessionIds"]:
            self.task_store.link_session(self.task_id, session_id)

    def _transaction(self) -> AbstractContextManager[Any]:
        engine = getattr(self.store, "engine", None)
        if engine is not None and (
            self.task_store is None or getattr(self.task_store, "engine", None) is engine
        ):
            return store_transaction(engine)
        return nullcontext()

    def _update_task_status(
        self, status: str, message: str, extras: dict[str, Any] | None = None,
        *, execution_owner: dict[str, Any] | None = None,
        accepted_by_human: bool = False,
    ) -> None:
        if not self.task_store:
            return
        extras = extras or {}
        execution_owner = execution_owner or self.task_execution_owner
        if self.task_id:
            task_ids = [self.task_id]
        else:
            # Links are history/navigation, never task execution authority.
            task_ids = []
        for task_id in task_ids:
            next_status = acceptance_status(
                self.task_store.get_task(task_id), status,
                accepted_by_human=accepted_by_human,
            )
            payload: dict[str, Any] = {"status": next_status, "reason": message}
            if next_status == "waiting_for_human" and extras.get("sessionId"):
                # The thread the answer belongs in; any other thread that once
                # ran this task must not offer to resume it.
                payload["sessionId"] = extras["sessionId"]
            if next_status == "waiting_for_human":
                # The wait itself, kept with the task so it outlives any status
                # question asked in the thread before answering. A park that
                # brought no record still gets an id an answer can name.
                payload["request"] = ensure_wait_record(extras.get("request"))
            if next_status == "blocked":
                payload["attention"] = {
                    "code": extras.get("code", "unknown"),
                    "source": "execution",
                    **{key: extras[key] for key in ("sessionId", "runId") if extras.get(key)},
                    **({"runRequestId": execution_owner["requestId"]}
                       if execution_owner else {}),
                }
            self.task_store.append_event(
                task_id,
                relay_task_event("task.status", task_id, payload),
                execution_owner=execution_owner,
            )
            self.task_store.record_activity(
                task_id, message,
                {key: value for key, value in extras.items() if key != "request"},
                execution_owner=execution_owner,
            )
