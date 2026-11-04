"""Include queued tasks in the dispatch queue index.

Revision ID: 20261104_0111
Revises: 20261104_0110
"""

from __future__ import annotations

from contextlib import nullcontext
import sqlalchemy as sa
from alembic import op

revision = "20261104_0111"
down_revision = "20261104_0110"
branch_labels = None
depends_on = None


def _replace(*, queued: bool) -> None:
    postgres = op.get_bind().dialect.name == "postgresql"
    statuses = "status IN ('assigned', 'queued')" if queued else "status = 'assigned'"
    predicate = f"{statuses} AND is_routine IS {'false' if postgres else '0'} AND deleted_at IS NULL"
    name = "ix_tasks_dispatch_queue"
    with op.get_context().autocommit_block() if postgres else nullcontext():
        # Keep the old index serving while its replacement is built.
        temporary = name + "_replacement" if postgres else name
        if not postgres:
            op.drop_index(name, table_name="tasks")
        op.create_index(
            temporary,
            "tasks",
            ["due_date", "created_at", "id"],
            **(
                {"postgresql_where": sa.text(predicate), "postgresql_concurrently": True}
                if postgres
                else {"sqlite_where": sa.text(predicate)}
            ),
        )
        if postgres:
            op.drop_index(name, table_name="tasks", postgresql_concurrently=True)
            op.execute(sa.text(f"ALTER INDEX {temporary} RENAME TO {name}"))


def upgrade() -> None:
    _replace(queued=True)


def downgrade() -> None:
    _replace(queued=False)
