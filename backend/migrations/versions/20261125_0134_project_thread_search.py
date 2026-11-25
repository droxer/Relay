"""Index substring searches over Project Thread titles and goals."""

from alembic import op
from sqlalchemy import text

revision = "20261125_0134"
down_revision = "20261124_0133"
branch_labels = None
depends_on = None

INDEXES = {
    "ix_sessions_project_title_trgm": "title",
    "ix_sessions_project_goal_trgm": "task_goal",
}


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public")
    with op.get_context().autocommit_block():
        bind = op.get_bind()
        for name, column in INDEXES.items():
            invalid = bind.scalar(text(
                "SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE c.relname = :name AND n.nspname = current_schema() AND NOT i.indisvalid"
            ), {"name": name})
            if invalid:
                op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
            op.execute(
                f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} "
                f"ON sessions USING gin ({column} public.gin_trgm_ops) WHERE project_id IS NOT NULL"
            )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for name in INDEXES:
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")
