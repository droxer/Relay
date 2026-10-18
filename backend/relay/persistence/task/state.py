"""The engine and tables every ``DatabaseTaskStore`` mixin shares."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from typing import TYPE_CHECKING


class TaskStoreState:
    metadata: Any
    tasks: Any
    events: Any
    number_counters: Any
    task_sessions: Any
    engine: Any
    emit_automation_events: Any

    if TYPE_CHECKING:
        # Methods one mixin calls on another, declared so each type-checks alone.
        def _current_snapshot(self, conn: Any, row: Any) -> dict[str, Any]:
            ...

        def _ensure_task_session(self, conn: Any, task_pk: str, session_id: str, timestamp: str) -> None:
            ...

        def _events_for_task(self, conn: Any, task_pk: str) -> list[dict[str, Any]]:
            ...

        def _hydrate_task(self, task: dict[str, Any]) -> dict[str, Any]:
            ...

        def _lock_session_for_link(self, conn: Any, session_id: str) -> None:
            ...

        def _next_task_number(self, conn: Any, scope: str) -> int:
            ...

        def _task_pk(self, conn: Any, task_id: str, *, lock: bool=False) -> str:
            ...

        def append_event(self, task_id: str, event: dict[str, Any], *, execution_owner: dict[str, Any] | None=None) -> dict[str, Any]:
            ...

        def append_events(self, task_id: str, events: list[dict[str, Any]], *, skip_linked_session_id: str | None=None, reject_active_claim: bool=False, active_linked_session: Callable[[dict[str, Any]], bool] | None=None, execution_owner: dict[str, Any] | None=None) -> dict[str, Any]:
            ...

        def get_task(self, task_id: str) -> dict[str, Any]:
            ...

        def record_activity(self, task_id: str, message: str, payload: dict[str, Any] | None=None, *, execution_owner: dict[str, Any] | None=None) -> dict[str, Any]:
            ...
