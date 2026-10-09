"""Read-only database size report behind ``relay storage-report``.

Artifact snapshots, skill blobs, and profile images are stored inline in the
database. That is deliberate while they are small (the daemon only inlines small
generated files), and this report is how to tell when it stops being true: when
``inlineContent`` becomes a large share of the total, move that content to an
object store keyed by its sha256 and keep only metadata in PostgreSQL.

On PostgreSQL, sizes come from ``pg_total_relation_size`` (heap, TOAST, and
indexes) and row counts are the planner's estimates, so the table walk is
cheap. The inline-content sums do read every content row; run the report
off-peak.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import create_engine, func, select, text

from .schema import metadata

INLINE_CONTENT_COLUMNS = {
    "sessionArtifactBytes": ("session_artifacts", "content"),
    "skillBlobBytes": ("skill_blobs", "content"),
    "profileImageBytes": ("profile_images", "content"),
}


def storage_report(database_url: str) -> dict[str, Any]:
    engine = create_engine(database_url)
    try:
        with engine.connect() as conn:
            postgres = conn.dialect.name == "postgresql"
            tables = [
                _postgres_table(conn, table.name) if postgres else _sqlite_table(conn, table)
                for table in metadata.sorted_tables
            ]
            inline = {
                label: _content_bytes(conn, table_name, column)
                for label, (table_name, column) in INLINE_CONTENT_COLUMNS.items()
            }
    finally:
        engine.dispose()
    tables.sort(key=lambda item: (item["totalBytes"] or 0, item["rows"]), reverse=True)
    return {"tables": tables, "inlineContent": inline}


def _postgres_table(conn: Any, name: str) -> dict[str, Any]:
    row = conn.execute(
        text(
            "SELECT pg_total_relation_size(c.oid) AS bytes, "
            "GREATEST(c.reltuples, 0)::bigint AS rows "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE c.relname = :name AND n.nspname = current_schema()"
        ),
        {"name": name},
    ).first()
    return {
        "name": name,
        "totalBytes": int(row.bytes) if row else 0,
        "rows": int(row.rows) if row else 0,
    }


def _sqlite_table(conn: Any, table: Any) -> dict[str, Any]:
    rows = conn.scalar(select(func.count()).select_from(table))
    return {"name": table.name, "totalBytes": None, "rows": int(rows or 0)}


def _content_bytes(conn: Any, table_name: str, column: str) -> int:
    table = metadata.tables[table_name]
    total = conn.scalar(select(func.coalesce(func.sum(func.length(table.c[column])), 0)))
    return int(total or 0)
