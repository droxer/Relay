"""Retain payload-bound acknowledgements independently of command history.

Revision ID: 20261110_0123
Revises: 20261109_0122

Upgrade before deploying receipt-based retry acknowledgement. Only small
identity/digest receipts persist; command payload and run retention are unchanged.
Downgrade deletes orphan receipts before restoring the original foreign key.
"""
from alembic import op
import sqlalchemy as sa

revision = "20261110_0123"
down_revision = "20261109_0122"
branch_labels = None
depends_on = None

FK_NAME = "fk_daemon_report_receipts_command_id_daemon_commands"
NAMING = {"fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s"}


def upgrade():
    constraints = sa.inspect(op.get_bind()).get_foreign_keys("daemon_report_receipts")
    for constraint in constraints:
        if constraint["referred_table"] == "daemon_commands":
            with op.batch_alter_table("daemon_report_receipts", naming_convention=NAMING) as batch:
                batch.drop_constraint(constraint["name"] or FK_NAME, type_="foreignkey")


def downgrade():
    op.execute(sa.text("""
        DELETE FROM daemon_report_receipts
        WHERE NOT EXISTS (
            SELECT 1 FROM daemon_commands WHERE daemon_commands.id = daemon_report_receipts.command_id
        )
    """))
    with op.batch_alter_table("daemon_report_receipts", naming_convention=NAMING) as batch:
        batch.create_foreign_key(FK_NAME, "daemon_commands", ["command_id"], ["id"], ondelete="CASCADE")
