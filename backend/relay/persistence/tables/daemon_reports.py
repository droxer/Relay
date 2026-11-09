"""Payload-bound durable report receipts; cascade with command history."""
from sqlalchemy import Column, ForeignKey, Table, Text
from ..sql import entity_uuid_type, metadata, json_type

report_receipts = Table(
    'daemon_report_receipts', metadata,
    Column('command_id', entity_uuid_type(), ForeignKey('daemon_commands.id', ondelete='CASCADE'), primary_key=True),
    Column('report_id', Text, primary_key=True),
    Column('node_id', Text, nullable=False),
    Column('digest', Text, nullable=False),
)

transport_state = Table(
    'daemon_transport_state', metadata,
    Column('computer_id', Text, primary_key=True),
    Column('snapshot', json_type(), nullable=False),
)
