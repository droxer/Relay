"""Materialize an agent's pinned model next to its runtime.

``agents.model`` mirrors ``snapshot.modelPolicy.model`` the same way
``executor_kind`` mirrors ``executorKind``: the snapshot (and the event log
behind it) stays authoritative, the column exists so the runtime and model can
be read and queried without unpacking JSON. NULL means the runtime default.
Existing agents are backfilled from their snapshot.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261010_0084"
down_revision = "20261006_0083"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
ID = sa.Uuid(as_uuid=False).with_variant(sa.Text(), "sqlite")


def upgrade() -> None:
    op.add_column("agents", sa.Column("model", sa.Text(), nullable=True))
    agents = sa.table(
        "agents",
        sa.column("id", ID),
        sa.column("snapshot", JSON),
        sa.column("model", sa.Text()),
    )
    bind = op.get_bind()
    for row in bind.execute(sa.select(agents.c.id, agents.c.snapshot)).mappings():
        policy = (row["snapshot"] or {}).get("modelPolicy")
        model = policy.get("model") if isinstance(policy, dict) else None
        if isinstance(model, str) and model.strip():
            bind.execute(
                agents.update()
                .where(agents.c.id == row["id"])
                .values(model=model.strip())
            )


def downgrade() -> None:
    op.drop_column("agents", "model")
