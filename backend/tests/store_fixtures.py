"""Database stores for tests.

Every aggregate is database-backed, so tests build their stores on a sqlite
file under the test's own directory. Stores built for the same root share that
one file -- and, through ``shared_engine``, one Engine -- exactly as the
running backend shares one database across stores.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import update

from relay.chat.integrations import DatabaseChatIntegrationStore
from relay.persistence.agent.placements import DatabaseAgentPlacementStore
from relay.persistence.agent.store import DatabaseAgentStore
from relay.persistence.daemon.managed_nodes import DatabaseManagedNodeStore
from relay.persistence.daemon.store import DatabaseDaemonStore
from relay.persistence.session.store import DatabaseSessionStore
from relay.persistence.task.store import DatabaseTaskStore
from relay.persistence.team.store import DatabaseTeamStore
from relay.security.auth import DatabaseAccountAuthStore
from postgres_backend import database_url_for

DATABASE_FILE = "relay.db"


def sqlite_url(root: str | Path) -> str:
    """The test database for ``root``: a sqlite file, or its Postgres stand-in
    when ``RELAY_TEST_STORE_BACKEND=postgres`` (see ``tests/postgres_backend.py``)."""
    directory = Path(root)
    directory.mkdir(parents=True, exist_ok=True)
    return database_url_for(f"sqlite:///{directory / DATABASE_FILE}")


def make_session_store(root: str | Path) -> DatabaseSessionStore:
    return DatabaseSessionStore(sqlite_url(root), create_schema=True)


def make_task_store(root: str | Path) -> DatabaseTaskStore:
    return DatabaseTaskStore(sqlite_url(root), create_schema=True)


def make_daemon_store(root: str | Path) -> DatabaseDaemonStore:
    return DatabaseDaemonStore(sqlite_url(root), create_schema=True)


def make_managed_node_store(root: str | Path) -> DatabaseManagedNodeStore:
    return DatabaseManagedNodeStore(sqlite_url(root), create_schema=True)


def make_agent_store(root: str | Path) -> DatabaseAgentStore:
    return DatabaseAgentStore(sqlite_url(root), create_schema=True)


def make_team_store(root: str | Path) -> DatabaseTeamStore:
    return DatabaseTeamStore(sqlite_url(root), create_schema=True)


def make_agent_placement_store(root: str | Path) -> DatabaseAgentPlacementStore:
    return DatabaseAgentPlacementStore(sqlite_url(root), create_schema=True)


def make_chat_store(root: str | Path) -> DatabaseChatIntegrationStore:
    return DatabaseChatIntegrationStore(sqlite_url(root), create_schema=True)


def make_auth_store(root: str | Path) -> DatabaseAccountAuthStore:
    return DatabaseAccountAuthStore(sqlite_url(root), create_schema=True)


def overwrite_snapshot(table: Any, engine: Any, record_id: str, snapshot: dict[str, Any]) -> None:
    """Replace one stored snapshot as an older runtime would have left it."""
    with engine.begin() as conn:
        conn.execute(update(table).where(table.c.id == record_id).values(snapshot=snapshot))


def create_run_request_on_node(daemon_store: Any, request: dict[str, Any]) -> dict[str, Any]:
    """Reserve a run, registering a bare node first: run requests reference
    their node row, so the node must exist before the reservation."""
    node_id = request["nodeId"]
    if daemon_store.get_node(node_id) is None:
        daemon_store.register_node({
            "id": node_id,
            "status": "ready",
            "createdAt": "2026-06-13T00:00:00.000Z",
            "updatedAt": "2026-06-13T00:00:00.000Z",
        })
    return daemon_store.create_run_request(request)
