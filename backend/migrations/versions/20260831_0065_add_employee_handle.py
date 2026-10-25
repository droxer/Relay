"""give employees a handle of their own

`employees.id` is a UUID — uuid5 of the handle for anything created through the
admin form — so the admin surfaces rendered `@<uuid>` and the @handle grammar
had nothing behind it. The handle becomes its own column: the display and
lookup identity, while `id` stays the foreign key everywhere.

Backfill order per row: the linked login's username, then a slug of the display
name, then the first 8 characters of the id. Collisions get a numeric suffix,
because the column is unique.

Revision ID: 20260831_0065
Revises: 20260831_0064
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from relay.ops.handle_backfill import plan_handles

revision = "20260831_0065"
down_revision = "20260831_0064"
branch_labels = None
depends_on = None


def _employees_table() -> sa.Table:
    """Describe the pre-migration employees table with its real UUID key."""
    return sa.table(
        "employees",
        sa.column(
            "id",
            postgresql.UUID(as_uuid=False).with_variant(sa.Text(), "sqlite"),
        ),
        sa.column("handle"),
        sa.column("display_name"),
        sa.column("created_at"),
    )


def upgrade() -> None:
    op.add_column("employees", sa.Column("handle", sa.Text(), nullable=True))

    connection = op.get_bind()
    employees = _employees_table()
    users = sa.table("auth_users", sa.column("username"), sa.column("employee_id"))

    usernames = {
        str(row["employee_id"]): row["username"]
        for row in connection.execute(
            sa.select(users.c.employee_id, users.c.username).where(
                users.c.employee_id.isnot(None)
            )
        ).mappings()
        if row["username"]
    }

    rows = (
        connection.execute(
            sa.select(employees.c.id, employees.c.display_name).order_by(
                employees.c.created_at, employees.c.id
            )
        )
        .mappings()
        .all()
    )
    # The rule itself lives in relay.persistence.employee_handle_backfill so
    # that `relay rehearse-employee-handles` can print exactly what this loop
    # is about to write, against a copy of the real database.
    for planned in plan_handles([dict(row) for row in rows], usernames):
        connection.execute(
            sa.update(employees)
            .where(employees.c.id == planned["id"])
            .values(handle=planned["handle"])
        )

    op.create_index("uq_employees_handle", "employees", ["handle"], unique=True)


def downgrade() -> None:
    op.drop_index("uq_employees_handle", table_name="employees")
    op.drop_column("employees", "handle")
