"""The engine, tables, and listeners every ``DatabaseSessionStore`` mixin shares."""

from __future__ import annotations

from typing import Any
from typing import TYPE_CHECKING


class SessionStoreState:
    REQUIRED_SCHEMA_REVISION: Any
    metadata: Any
    sessions: Any
    events: Any
    artifacts: Any
    run_token_usage: Any
    agent_runs: Any
    workspace_files: Any
    tombstones: Any
    engine: Any
    blob_store: Any
    emit_automation_events: Any
    _affinity_lock: Any
    _event_changes: Any

    if TYPE_CHECKING:
        # Methods one mixin calls on another, declared so each type-checks alone.
        def _events_for_session(self, conn: Any, session_pk: str) -> list[dict[str, Any]]:
            ...

        def _index_workspace_files(self, conn: Any, session_pk: str, session: dict[str, Any], artifacts: list[dict[str, Any]]) -> None:
            ...

        def _insert_agent_run(self, conn: Any, session_pk: str, run: dict[str, Any]) -> None:
            ...

        def _notify_event(self, session_id: str) -> None:
            ...

        def _session_pk(self, conn: Any, session_id: str, *, lock: bool=False) -> str:
            ...

        def _sync_run_token_usage(self, conn: Any, session_pk: str, session: dict[str, Any], run_id: str) -> None:
            ...

        def get_session(self, session_id: str) -> dict[str, Any]:
            ...
