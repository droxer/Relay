"""Build automation routing/retention indexes concurrently and retryably.

Revision ID: 20261106_0119
Revises: 20261106_0118

The autocommit boundary deliberately follows the transactional schema change.
A failed build can be retried from 0118; invalid indexes are rebuilt.
"""

from alembic import op
import sqlalchemy as sa

revision = "20261106_0119"
down_revision = "20261106_0118"
branch_labels = None
depends_on = None

PREDICATE = "is_routine IS true AND routine_state = 'active' AND deleted_at IS NULL AND routine_listens IS true"
INDEXES = {
    "ix_automation_outbox_routing": "automation_outbox (COALESCE(routed_at, created_at), id)",
    "ix_automation_outbox_created": "automation_outbox (created_at, id)",
    "ix_tasks_automation_routing": f"tasks (created_at, id) WHERE {PREDICATE}",
}


def _create(name, definition):
    invalid = op.get_bind().scalar(sa.text("""
      SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = :name AND n.nspname = current_schema() AND NOT i.indisvalid
    """), {"name": name})
    if invalid:
        op.execute(sa.text(f'DROP INDEX CONCURRENTLY IF EXISTS "{name}"'))
    op.execute(sa.text(f'CREATE INDEX CONCURRENTLY IF NOT EXISTS "{name}" ON {definition}'))


def upgrade():
    with op.get_context().autocommit_block():
        for name, definition in INDEXES.items():
            _create(name, definition)
        op.execute(sa.text('DROP INDEX CONCURRENTLY IF EXISTS "ix_tasks_listening_routines"'))


def downgrade():
    # Check before entering autocommit: a rejected rollback leaves head and
    # its indexes intact, rather than partially reverting their definitions.
    if op.get_bind().scalar(sa.text(
        "SELECT 1 FROM automation_outbox WHERE routing_after_id IS NOT NULL LIMIT 1"
    )):
        raise RuntimeError("Finish partial automation broadcast routing with the new workers before downgrade.")
    with op.get_context().autocommit_block():
        _create("ix_tasks_listening_routines", f"tasks (created_at) WHERE {PREDICATE}")
        for name in INDEXES:
            op.execute(sa.text(f'DROP INDEX CONCURRENTLY IF EXISTS "{name}"'))
