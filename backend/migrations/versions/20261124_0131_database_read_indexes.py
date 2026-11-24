"""Index control-plane reads, queue recovery, and reverse foreign-key lookups.

Revision ID: 20261124_0131
Revises: 20261117_0130

Build replacements before dropping older indexes. The operations run outside
the migration transaction, and a retry replaces any incomplete index build.
"""

from alembic import op
from sqlalchemy import text

revision = "20261124_0131"
down_revision = "20261117_0130"
branch_labels = None
depends_on = None

NEW_INDEXES = {
    "ix_sessions_recency": "sessions (updated_at, id)",
    "ix_sessions_owner_recency": "sessions (owner_user_id, updated_at, id)",
    "ix_sessions_project_owner_recency": (
        "sessions (project_id, owner_user_id, updated_at, id) WHERE project_id IS NOT NULL"
    ),
    "ix_sessions_queued_threads": (
        "sessions (id) WHERE (snapshot #>> '{messageQueue,messages,0,id}') IS NOT NULL "
        "AND (snapshot #>> '{messageQueue,paused}') = 'false'"
    ),
    "ix_skill_revisions_created_by_user": "skill_revisions (created_by_user_id)",
    "ix_skill_assignments_created_by_user": "skill_assignments (created_by_user_id, skill_id)",
    "ix_workflows_project": "workflows (project_id) WHERE project_id IS NOT NULL",
    "ix_workflows_owner_team": "workflows (owner_team_id) WHERE owner_team_id IS NOT NULL",
    "ix_team_workflow_links_workflow": "team_workflow_links (workflow_id, team_id)",
    "ix_managed_node_records_owner": "managed_node_records ((snapshot ->> 'userId')) WHERE kind = 'nodes'",
    "ix_managed_node_records_daemon": (
        "managed_node_records ((snapshot ->> 'activeDaemonNodeId')) "
        "WHERE kind = 'nodes' AND (snapshot ->> 'activeDaemonNodeId') IS NOT NULL"
    ),
    "ix_managed_node_records_deleted": (
        "managed_node_records (COALESCE(snapshot ->> 'updatedAt', snapshot ->> 'createdAt'), id) "
        "WHERE kind = 'nodes' AND (snapshot ->> 'desiredState') = 'deleted' AND (snapshot ->> 'phase') = 'deleted'"
    ),
    "ix_tasks_dispatch_order": (
        "tasks ((priority <> 'high'), (priority = 'low'), "
        "(due_date IS NULL), COALESCE(due_date, '9999-12-31'), created_at, id) "
        "WHERE status IN ('assigned', 'queued') AND is_routine IS false AND deleted_at IS NULL "
        "AND (assigned_agent IS NOT NULL OR assigned_team_id IS NOT NULL OR project_id IS NOT NULL)"
    ),
    "ix_notifications_visible_recency": "notifications (user_id, created_at, id) WHERE cleared_at IS NULL",
    "ix_notifications_unread": "notifications (user_id, kind) WHERE cleared_at IS NULL AND read_at IS NULL",
    "ix_daemon_run_requests_command": "daemon_run_requests (current_command_id) WHERE current_command_id IS NOT NULL",
    "ix_projects_computer_workspace": "projects (computer_id, workspace_subpath)",
    "ix_tasks_wip_scope": (
        "tasks (COALESCE(assignee_user_id, owner_user_id)) "
        "WHERE status NOT IN ('review', 'done', 'cancelled') "
        "AND (snapshot ->> 'workflowStage') IS DISTINCT FROM 'review' "
        "AND is_routine IS false AND deleted_at IS NULL "
        "AND ((snapshot ->> 'startedAt') IS NOT NULL OR status IN ('running', 'waiting_for_human'))"
    ),
}
OLD_INDEXES = {
    "ix_sessions_updated_at": "sessions (updated_at)",
    "ix_sessions_owner_updated_at": "sessions (owner_user_id, updated_at)",
    "ix_sessions_project_id": "sessions (project_id)",
    "ix_skill_revisions_skill": "skill_revisions (skill_id, revision)",
    "ix_skill_assignments_skill": "skill_assignments (skill_id)",
    "ix_tasks_dispatch_queue": (
        "tasks (due_date, created_at, id) WHERE status IN ('assigned', 'queued') "
        "AND is_routine IS false AND deleted_at IS NULL"
    ),
    "ix_notifications_user_id_created_at": "notifications (user_id, created_at)",
    "ix_daemon_run_requests_current_command": (
        "daemon_run_requests (current_command_id) "
        "WHERE status IN ('prepared', 'running', 'dispatching', 'finalizing')"
    ),
}


def _replace(create: dict[str, str], drop: dict[str, str]) -> None:
    with op.get_context().autocommit_block():
        bind = op.get_bind()
        for name, definition in create.items():
            invalid = bind.scalar(text(
                "SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE c.relname = :name AND n.nspname = current_schema() AND NOT i.indisvalid"
            ), {"name": name})
            if invalid:
                op.execute(f'DROP INDEX CONCURRENTLY IF EXISTS "{name}"')
            op.execute(f'CREATE INDEX CONCURRENTLY IF NOT EXISTS "{name}" ON {definition}')
        for name in drop:
            op.execute(f'DROP INDEX CONCURRENTLY IF EXISTS "{name}"')


def upgrade() -> None:
    _replace(NEW_INDEXES, OLD_INDEXES)


def downgrade() -> None:
    _replace(OLD_INDEXES, NEW_INDEXES)
