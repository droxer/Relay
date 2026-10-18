"""The engine, tables, and listeners every ``DatabaseDaemonStore`` mixin shares."""

from __future__ import annotations

from typing import Any
from typing import TYPE_CHECKING


class DaemonStoreState:
    metadata: Any
    nodes: Any
    node_agents: Any
    commands: Any
    runs: Any
    run_requests: Any
    events: Any
    engine: Any
    _command_changes: Any
    _workspace_changes: Any

    if TYPE_CHECKING:
        # Methods one mixin calls on another, declared so each type-checks alone.
        def _append_daemon_event(self, conn: Any, event: dict[str, Any]) -> None:
            ...

        def _node_pk(self, conn: Any, node_id: str) -> str:
            ...

        def _notify_command(self, node_id: str) -> None:
            ...

        def _notify_workspace(self, command_id: str) -> None:
            ...

        def get_command(self, command_id: str) -> dict[str, Any] | None:
            ...
