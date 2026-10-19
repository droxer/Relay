"""convert the remaining entity-reference columns to native UUID

Revision ID: 20260730_0047
Revises: 20260730_0046

Migration 0040 converted sixteen id columns to native ``uuid`` and left the
rest as ``text`` holding uuid strings. The split meant a reference could not be
joined to its target without a cast (``text = uuid`` is an error in Postgres,
and a cast defeats the index), and nothing stopped a non-uuid value from being
stored -- which is exactly what happened: ``agents.supervisor_employee_id`` and
``agent_placements.supervisor_employee_id`` still held legacy employee handles
("admin", "alice") that 0042 failed to rewrite, and ``tasks.assigned_team_id``
held a dropped legacy team public id.

So this migration repairs before it converts. For each column it resolves the
authoritative value using the snapshot rule documented in
the reducers (``persistence/session/reducer.py``, ``persistence/task/reducer.py``) -- the snapshot wins, the derived column is a
projection -- falling back to the column when the snapshot lacks the key, and
to an employee-handle lookup when neither holds a uuid.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

import sqlalchemy as sa
from alembic import op

revision = "20260730_0047"
down_revision = "20260730_0046"
branch_labels = None
depends_on = None

logger = logging.getLogger(__name__)

LOCK_TIMEOUT = "10s"


class Ref:
    """One entity-reference column to repair and then retype."""

    def __init__(
        self,
        table: str,
        column: str,
        *,
        snapshot_key: str | None = None,
        required: bool = False,
        employee_handles: bool = False,
    ):
        self.table = table
        self.column = column
        self.snapshot_key = snapshot_key
        self.required = required
        self.employee_handles = employee_handles


REFERENCES = (
    Ref(
        "agents",
        "supervisor_employee_id",
        snapshot_key="supervisorEmployeeId",
        required=True,
        employee_handles=True,
    ),
    Ref(
        "agent_placements",
        "supervisor_employee_id",
        snapshot_key="supervisorEmployeeId",
        required=True,
        employee_handles=True,
    ),
    Ref(
        "teams",
        "owner_employee_id",
        snapshot_key="ownerEmployeeId",
        required=True,
        employee_handles=True,
    ),
    Ref(
        "sessions",
        "owner_employee_id",
        snapshot_key="ownerEmployeeId",
        employee_handles=True,
    ),
    Ref(
        "tasks",
        "owner_employee_id",
        snapshot_key="ownerEmployeeId",
        employee_handles=True,
    ),
    Ref(
        "tasks",
        "assignee_employee_id",
        snapshot_key="assigneeEmployeeId",
        employee_handles=True,
    ),
    Ref("tasks", "assigned_team_id", snapshot_key="assignedTeamId"),
    Ref("daemon_nodes", "employee_id", employee_handles=True),
    Ref("daemon_nodes", "managed_node_id"),
    Ref("session_run_token_usage", "owner_employee_id", employee_handles=True),
    Ref("session_tombstones", "owner_employee_id", employee_handles=True),
    Ref("daemon_runs", "placement_id"),
    Ref("daemon_run_requests", "task_id"),
    Ref("daemon_run_requests", "current_command_id"),
    Ref("daemon_run_requests", "current_run_id"),
)


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    tables = set(inspector.get_table_names())
    handles = _employee_handles(connection, tables)

    for ref in REFERENCES:
        if ref.table not in tables:
            continue
        columns = {item["name"] for item in inspector.get_columns(ref.table)}
        if ref.column not in columns:
            continue
        has_snapshot = ref.snapshot_key is not None and "snapshot" in columns
        _repair(connection, ref, handles, has_snapshot=has_snapshot)

    if connection.dialect.name != "postgresql":
        # SQLite cannot retype in place, and it stores uuids as TEXT anyway.
        # The repair above is what the SQLite migration tests exercise.
        return

    op.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
    for ref in REFERENCES:
        if ref.table not in tables:
            continue
        logger.info("0047: converting %s.%s to UUID", ref.table, ref.column)
        op.alter_column(
            ref.table,
            ref.column,
            existing_type=sa.Text(),
            type_=sa.Uuid(as_uuid=False),
            existing_nullable=not ref.required,
            postgresql_using=f'"{ref.column}"::uuid',
        )


def downgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "postgresql":
        return
    for ref in reversed(REFERENCES):
        op.alter_column(
            ref.table,
            ref.column,
            existing_type=sa.Uuid(as_uuid=False),
            type_=sa.Text(),
            existing_nullable=not ref.required,
            postgresql_using=f'"{ref.column}"::text',
        )


def _employee_handles(connection: Any, tables: set[str]) -> dict[str, str]:
    """Map the legacy employee handle (its display name) to the employee uuid."""
    if "employees" not in tables:
        return {}
    rows = connection.execute(
        sa.text("SELECT id, display_name FROM employees")
    ).mappings()
    handles: dict[str, str] = {}
    for row in rows:
        name = (row["display_name"] or "").strip().casefold()
        if name and name not in handles:
            handles[name] = str(row["id"])
    return handles


def _repair(
    connection: Any,
    ref: Ref,
    handles: dict[str, str],
    *,
    has_snapshot: bool,
) -> None:
    selected = f'id, "{ref.column}"' + (", snapshot" if has_snapshot else "")
    rows = connection.execute(
        sa.text(f'SELECT {selected} FROM "{ref.table}"')  # noqa: S608 - fixed names
    ).mappings().all()

    repaired = 0
    cleared = 0
    for row in rows:
        current = _as_text(row[ref.column])
        snapshot = _snapshot_dict(row["snapshot"]) if has_snapshot else None
        from_snapshot = (
            _as_text(snapshot.get(ref.snapshot_key))
            if snapshot is not None and ref.snapshot_key
            else None
        )

        resolved = _resolve(current, from_snapshot, ref, handles)
        if resolved is None and ref.required:
            raise RuntimeError(
                f"Cannot convert {ref.table}.{ref.column} to UUID: row {row['id']} "
                f"holds {current!r} with no matching employee. Repair the row, "
                "then re-run this migration."
            )

        snapshot_needs_write = (
            snapshot is not None
            and ref.snapshot_key is not None
            and resolved is not None
            and from_snapshot != resolved
        )
        if resolved == current and not snapshot_needs_write:
            continue

        values: dict[str, Any] = {"row_id": row["id"], "value": resolved}
        assignments = f'"{ref.column}" = :value'
        if snapshot_needs_write:
            assert snapshot is not None
            values["snapshot"] = json.dumps({**snapshot, ref.snapshot_key: resolved})
            assignments += ", snapshot = :snapshot"
        connection.execute(
            sa.text(  # noqa: S608 - fixed names
                f'UPDATE "{ref.table}" SET {assignments} WHERE id = :row_id'
            ),
            values,
        )
        if resolved is None:
            cleared += 1
        else:
            repaired += 1

    if repaired or cleared:
        logger.info(
            "0047: %s.%s repaired %d row(s), cleared %d dangling reference(s)",
            ref.table,
            ref.column,
            repaired,
            cleared,
        )


def _resolve(
    current: str | None,
    from_snapshot: str | None,
    ref: Ref,
    handles: dict[str, str],
) -> str | None:
    # The snapshot is authoritative; the column is a derived projection.
    if _is_uuid(from_snapshot):
        return from_snapshot
    if _is_uuid(current):
        return current
    if ref.employee_handles:
        for candidate in (from_snapshot, current):
            if not candidate:
                continue
            mapped = handles.get(candidate.strip().casefold())
            if mapped:
                return mapped
    return None


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _snapshot_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, (str, bytes)):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _is_uuid(value: Any) -> bool:
    if not value:
        return False
    try:
        uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return False
    return True
