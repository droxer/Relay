"""Drop project_members.function_title."""
from alembic import op
import sqlalchemy as sa

revision = "20260921_0079"
down_revision = "20260920_0078"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("project_members") as batch:
        batch.drop_column("function_title")


def downgrade() -> None:
    with op.batch_alter_table("project_members") as batch:
        batch.add_column(sa.Column("function_title", sa.Text(), nullable=False, server_default=""))
        batch.alter_column("function_title", server_default=None)
