"""Resolve a standalone Task's saved Computer and older Thread-based ownership."""

from collections.abc import Mapping, Sequence
from itertools import batched
from typing import Any

from sqlalchemy import Connection, case, func, select

from ...core.computer_identity import computer_id
from .. import sql
from ..tables.daemon import nodes
from ..tables.sessions import sessions


def bound_computer(snapshot: Any) -> Any:
    return func.coalesce(
        func.nullif(snapshot["workspaceBinding"]["computerId"].as_string(), ""),
        func.nullif(snapshot["computerId"].as_string(), ""),
    )


def computer_list_columns(snapshot: Any, bound: Any) -> list[Any]:
    return [
        bound.label("bound"),
        case((bound.is_(None), snapshot["linkedSessionIds"]), else_=None).label("linked_sessions"),
    ]


def linked_computers(conn: Connection, owner: str, session_ids: set[str]) -> dict[str, str]:
    snapshot = sessions.c.snapshot
    session_nodes: dict[str, str] = {}
    identities: dict[str, str] = {}
    for ids in batched((key for key in session_ids if not sql.names_no_uuid_row(conn.engine, key)), 500, strict=False):
        rows = conn.execute(select(
            sessions.c.id, snapshot["computerId"].as_string().label("computer"),
            snapshot["daemonNodeId"].as_string().label("node"),
        ).where(sessions.c.owner_user_id == owner, sessions.c.id.in_(ids))).mappings()
        for row in rows:
            if row["computer"]:
                identities[row["id"]] = row["computer"]
            elif row["node"]:
                session_nodes[row["id"]] = row["node"]
    node_ids = set(session_nodes.values())
    node_computers: dict[str, str] = {}
    for ids in batched((key for key in node_ids if not sql.names_no_uuid_row(conn.engine, key)), 500, strict=False):
        rows = conn.execute(select(
            nodes.c.id, nodes.c.user_id.label("userId"), nodes.c.workspace_id.label("workspaceId"),
            nodes.c.managed_node_id.label("managedNodeId"),
        ).where(nodes.c.id.in_(ids))).mappings()
        node_computers.update((row["id"], computer_id(dict(row))) for row in rows)
    identities.update((key, node_computers.get(node, f"node:{node}")) for key, node in session_nodes.items())
    return identities


def latest_computer(ids: list[str], identities: dict[str, str]) -> str | None:
    return next((identities[key] for key in reversed(ids) if key in identities), None)


def with_effective_computers(
    conn: Connection, owner: str, rows: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    identities = linked_computers(conn, owner, {key for row in rows for key in row["linked_sessions"] or ()})
    return [
        dict(row, effective_computer=row["bound"] or latest_computer(row["linked_sessions"] or [], identities))
        for row in rows
    ]
