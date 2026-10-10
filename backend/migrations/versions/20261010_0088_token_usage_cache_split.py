"""Split cached tokens into reads and writes; record unreported runs.

``session_run_token_usage.cache_tokens`` lumped prompt-cache reads together
with cache writes, although they bill roughly 0.1x and 1.25x input. The new
``cache_read_tokens`` / ``cache_write_tokens`` keep them apart, and
``cache_tokens`` stays their sum. Existing rows predate the split; almost all
of their cache count was reads, so it is backfilled as reads.

``agent`` and ``reported`` let the ledger also hold a zero row for a run that
completed without reporting counts, so the dashboard can say which runtimes
went unmeasured instead of keeping a hardcoded list. Existing rows all carried
counts, hence the ``true`` default.

Revision ID: 20261010_0088
Revises: 20261010_0087
"""

import sqlalchemy as sa
from alembic import op

revision = "20261010_0088"
down_revision = "20261010_0087"
branch_labels = None
depends_on = None

TABLE = "session_run_token_usage"


def upgrade() -> None:
    with op.batch_alter_table(TABLE) as batch:
        batch.add_column(
            sa.Column("cache_read_tokens", sa.BigInteger(), nullable=False, server_default="0")
        )
        batch.add_column(
            sa.Column("cache_write_tokens", sa.BigInteger(), nullable=False, server_default="0")
        )
        batch.add_column(sa.Column("agent", sa.Text(), nullable=True))
        batch.add_column(
            sa.Column("reported", sa.Boolean(), nullable=False, server_default=sa.true())
        )
    op.execute(f"UPDATE {TABLE} SET cache_read_tokens = cache_tokens")


def downgrade() -> None:
    # Unreported rows have no counts and no meaning to the older schema.
    op.execute(f"DELETE FROM {TABLE} WHERE reported IS false")
    with op.batch_alter_table(TABLE) as batch:
        batch.drop_column("reported")
        batch.drop_column("agent")
        batch.drop_column("cache_write_tokens")
        batch.drop_column("cache_read_tokens")
