"""Independent Project Workflow definitions, links, and authoritative events."""
from sqlalchemy import BigInteger, CheckConstraint, Column, DateTime, ForeignKey, Index, Table, Text, UniqueConstraint, text
from ..sql import database_id_column, entity_uuid_type, json_type, metadata

workflows = Table(
    'workflows', metadata, database_id_column(),
    Column('owner_user_id', entity_uuid_type(), ForeignKey('users.id', ondelete='RESTRICT'), nullable=False),
    Column('project_id', entity_uuid_type(), ForeignKey('projects.id', ondelete='RESTRICT'), nullable=True),
    Column('owner_team_id', entity_uuid_type(), ForeignKey('teams.id', ondelete='RESTRICT'), nullable=True),
    Column('computer_id', Text, nullable=True),
    CheckConstraint('(project_id IS NOT NULL AND owner_team_id IS NULL AND computer_id IS NULL) OR '
                    '(project_id IS NULL AND owner_team_id IS NOT NULL AND computer_id IS NULL) OR '
                    '(project_id IS NULL AND owner_team_id IS NULL AND computer_id IS NOT NULL)', name='ck_workflow_owner_scope'),
    Column('name', Text, nullable=False), Column('name_key', Text, nullable=False),
    Column('snapshot', json_type(), nullable=False), Column('event_version', BigInteger, nullable=False),
    Column('created_at', DateTime(timezone=True), nullable=False),
    Column('updated_at', DateTime(timezone=True), nullable=False),
    Column('deleted_at', DateTime(timezone=True), nullable=True),
    Index('ix_workflows_owner_project', 'owner_user_id', 'project_id'),
    Index('ix_workflows_owner_computer', 'owner_user_id', 'computer_id'),
    Index('ix_workflows_project', 'project_id',
          postgresql_where=text('project_id IS NOT NULL'), sqlite_where=text('project_id IS NOT NULL')),
    Index('ix_workflows_owner_team', 'owner_team_id',
          postgresql_where=text('owner_team_id IS NOT NULL'), sqlite_where=text('owner_team_id IS NOT NULL')),
    Index('ix_workflows_live_project_name', 'project_id', 'name_key',
          postgresql_where=text('deleted_at IS NULL'), sqlite_where=text('deleted_at IS NULL')),
)
links = Table(
    'team_workflow_links', metadata,
    Column('team_id', entity_uuid_type(), ForeignKey('teams.id', ondelete='CASCADE'), primary_key=True),
    Column('workflow_id', entity_uuid_type(), ForeignKey('workflows.id', ondelete='RESTRICT'), primary_key=True),
    Index('ix_team_workflow_links_workflow', 'workflow_id', 'team_id'),
)
events = Table(
    'workflow_events', metadata, database_id_column(),
    Column('workflow_id', entity_uuid_type(), ForeignKey('workflows.id', ondelete='RESTRICT'), nullable=False),
    Column('sequence', BigInteger, nullable=False), Column('type', Text, nullable=False),
    Column('timestamp', DateTime(timezone=True), nullable=False), Column('payload', json_type(), nullable=False),
    UniqueConstraint('workflow_id', 'sequence', name='uq_workflow_events_sequence'),
)
