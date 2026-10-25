from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import (
    Index,
)

from ..engine import create_all_tables, shared_engine
from ..sql import metadata as shared_metadata
from ..tables import daemon as daemon_tables
from ..tables.daemon import ACTIVE_RUN_REQUEST_STATUSES
from ...core.daemon_records import TERMINAL_DAEMON_STATUSES
from .rows import terminal_time_expression
from .nodes import NodeRows
from .commands import CommandQueueRows
from .run_requests import RunRequestRows
from .workspace_responses import WorkspaceResponseRows
from .maintenance import DaemonRecordMaintenance
from ..listeners import ChangeListener



class DatabaseDaemonStore(
    NodeRows,
    CommandQueueRows,
    RunRequestRows,
    WorkspaceResponseRows,
    DaemonRecordMaintenance,
):
    metadata = shared_metadata

    nodes = daemon_tables.nodes
    node_agents = daemon_tables.node_agents
    commands = daemon_tables.commands
    runs = daemon_tables.runs
    run_requests = daemon_tables.run_requests
    events = daemon_tables.events

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        self._command_changes = ChangeListener("Daemon command")
        self._workspace_changes = ChangeListener("Workspace response")
        if create_schema:
            create_all_tables(self.engine)

    def set_command_listener(
        self, listener: Callable[[str], None], *, database_channel: str | None = None
    ) -> None:
        self._command_changes.attach(listener, database_channel)

    def _notify_command(self, node_id: str) -> None:
        self._command_changes.fire(node_id)

    def set_workspace_listener(
        self, listener: Callable[[str], None], *, database_channel: str | None = None
    ) -> None:
        self._workspace_changes.attach(listener, database_channel)

    def _notify_workspace(self, command_id: str) -> None:
        self._workspace_changes.fire(command_id)


































































Index("ix_daemon_run_requests_current_command", DatabaseDaemonStore.run_requests.c.current_command_id,
      postgresql_where=DatabaseDaemonStore.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES),
      sqlite_where=DatabaseDaemonStore.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES))
Index("ix_daemon_run_requests_terminal_retention", DatabaseDaemonStore.run_requests.c.updated_at,
      DatabaseDaemonStore.run_requests.c.id,
      postgresql_where=DatabaseDaemonStore.run_requests.c.status.not_in(ACTIVE_RUN_REQUEST_STATUSES),
      sqlite_where=DatabaseDaemonStore.run_requests.c.status.not_in(ACTIVE_RUN_REQUEST_STATUSES))
Index("ix_daemon_run_requests_recovery", DatabaseDaemonStore.run_requests.c.recovery_after,
      DatabaseDaemonStore.run_requests.c.id,
      postgresql_where=DatabaseDaemonStore.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES),
      sqlite_where=DatabaseDaemonStore.run_requests.c.status.in_(ACTIVE_RUN_REQUEST_STATUSES))
for _table in (DatabaseDaemonStore.commands, DatabaseDaemonStore.runs):
    Index(f"ix_{_table.name}_terminal_retention", _table.c.node_id,
          terminal_time_expression(_table), _table.c.id,
          postgresql_where=_table.c.status.in_(TERMINAL_DAEMON_STATUSES),
          sqlite_where=_table.c.status.in_(TERMINAL_DAEMON_STATUSES))
