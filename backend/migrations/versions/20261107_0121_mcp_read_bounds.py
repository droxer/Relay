"""Bound Project tool hydration and retain Unicode casefold search.

Revision ID: 20261107_0121
Revises: 20261106_0120

Stop application writers for the title backfill, then deploy the new writer.
The concurrent index phase commits the backfill; interrupted builds are safe
to retry. Downgrade removes only the derived column and indexes.
"""
from alembic import op
import sqlalchemy as sa

revision = "20261107_0121"
down_revision = "20261106_0120"
branch_labels = None
depends_on = None

INDEXES = (
    ("ix_tasks_project_live_id", "tasks", ["project_id", "owner_user_id", "id"], "deleted_at IS NULL"),
    ("ix_task_events_task_time", "task_events", ["task_id", "timestamp", "sequence"], None),
    ("ix_session_events_report_time", "session_events", ["session_id", "type", "timestamp", "sequence"], None),
    ("ix_project_events_project_time", "project_events", ["project_id", "timestamp", "sequence"], None),
)


def _indexes(create):
    bind = op.get_bind()
    for name, table, columns, predicate in INDEXES:
        if bind.dialect.name == "postgresql":
            invalid = bind.scalar(sa.text("""
              SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname = :name AND n.nspname = current_schema() AND NOT i.indisvalid
            """), {"name": name})
            if not create or invalid:
                op.execute(sa.text(f'DROP INDEX CONCURRENTLY IF EXISTS "{name}"'))
            if create:
                where = f" WHERE {predicate}" if predicate else ""
                op.execute(sa.text(f'CREATE INDEX CONCURRENTLY IF NOT EXISTS "{name}" ON {table} ({", ".join(columns)}){where}'))
        else:
            exists = name in {index["name"] for index in sa.inspect(bind).get_indexes(table)}
            if create and not exists:
                op.create_index(name, table, columns, sqlite_where=sa.text(predicate) if predicate else None)
            elif not create and exists:
                op.drop_index(name, table_name=table)


def upgrade():
    bind = op.get_bind()
    if "title_casefold" not in {column["name"] for column in sa.inspect(bind).get_columns("tasks")}:
        op.add_column("tasks", sa.Column("title_casefold", sa.Text(), nullable=False, server_default=""))
    # Read only scalar columns in bounded batches, including on a retry.
    after = None
    while True:
        statement = "SELECT id, title FROM tasks"
        if after is not None:
            statement += " WHERE id > :after"
        rows = bind.execute(sa.text(statement + " ORDER BY id LIMIT 500"), {"after": after}).all()
        if not rows:
            break
        bind.execute(sa.text("UPDATE tasks SET title_casefold = :folded WHERE id = :id"),
                     [{"id": row.id, "folded": row.title.casefold()} for row in rows])
        after = rows[-1].id
    if bind.dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            _indexes(True)
    else:
        _indexes(True)


def downgrade():
    if op.get_bind().dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            _indexes(False)
    else:
        _indexes(False)
    op.drop_column("tasks", "title_casefold")
