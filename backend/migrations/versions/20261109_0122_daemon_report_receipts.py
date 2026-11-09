"""Payload-bound durable daemon report acknowledgements.

Revision ID: 20261109_0122
Revises: 20261107_0121
"""
from alembic import op
import sqlalchemy as sa
from relay.persistence.sql import entity_uuid_type, json_type

revision = '20261109_0122'
down_revision = '20261107_0121'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('daemon_report_receipts',
        sa.Column('command_id', entity_uuid_type(), sa.ForeignKey('daemon_commands.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('report_id', sa.Text(), primary_key=True),
        sa.Column('node_id', sa.Text(), nullable=False),
        sa.Column('digest', sa.Text(), nullable=False))

    op.create_table('daemon_transport_state', sa.Column('computer_id', sa.Text(), primary_key=True), sa.Column('snapshot', json_type(), nullable=False))


def downgrade():
    op.drop_table('daemon_transport_state')
    op.drop_table('daemon_report_receipts')
