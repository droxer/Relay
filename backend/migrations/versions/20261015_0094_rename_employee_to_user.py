"""Rename "employee" to "user", and the login record to "account".

"Employee" assumed an organization; "user" is the generic name for the person
who owns agents, computers, threads, and tasks. The login credential that
pointed at an employee (``auth_users``) becomes an *account*, so "user" names
one thing only.

Schema: ``employees`` -> ``users``, ``auth_users`` -> ``auth_accounts``,
``auth_sessions.user_id`` -> ``account_id``, and every ``*employee*`` column,
index, and named constraint follows. Values: a computer's ``node_location``
``employee-device`` -> ``user-device`` and a skill assignment's
``target_type`` ``employee`` -> ``user``.

Names Postgres generated itself (``employees_pkey``, ``*_employee_id_fkey``,
...) are found in the catalog and renamed by the same rule, so a database whose
generated names differ is renamed as far as it matches and never fails.

The JSON keys inside event payloads and snapshots are rewritten by the next
revision, ``20261015_0095``, in committed batches so these table locks are not
held for the length of a full event-log scan.

Handle-derived ids are *not* recomputed: they hash under the "employee" kind
(``relay.security.entity_ids.USER_ENTITY_KIND``) on purpose.

Revision ID: 20261015_0094
Revises: 20261013_0093
"""

from __future__ import annotations

import re

import sqlalchemy as sa
from alembic import op

revision = "20261015_0094"
down_revision = "20261013_0093"
branch_labels = None
depends_on = None

TABLES = (("employees", "users"), ("auth_users", "auth_accounts"))

# (table after the table rename, old column, new column)
COLUMNS = (
    ("auth_sessions", "user_id", "account_id"),
    ("auth_accounts", "employee_id", "user_id"),
    ("agent_placements", "supervisor_employee_id", "supervisor_user_id"),
    ("agents", "supervisor_employee_id", "supervisor_user_id"),
    ("computer_authorizations", "employee_id", "user_id"),
    ("daemon_nodes", "employee_id", "user_id"),
    ("org_settings", "max_local_computers_per_employee", "max_local_computers_per_user"),
    ("projects", "owner_employee_id", "owner_user_id"),
    ("session_run_token_usage", "owner_employee_id", "owner_user_id"),
    ("session_tombstones", "owner_employee_id", "owner_user_id"),
    ("session_workspace_files", "owner_employee_id", "owner_user_id"),
    ("sessions", "owner_employee_id", "owner_user_id"),
    ("skill_assignments", "created_by_employee_id", "created_by_user_id"),
    ("skill_revisions", "created_by_employee_id", "created_by_user_id"),
    ("skills", "owner_employee_id", "owner_user_id"),
    ("tasks", "owner_employee_id", "owner_user_id"),
    ("tasks", "assignee_employee_id", "assignee_user_id"),
    ("teams", "owner_employee_id", "owner_user_id"),
)

INDEXES = (
    ("ix_agent_placements_supervisor_employee_id", "ix_agent_placements_supervisor_user_id"),
    ("ix_agents_supervisor_employee_id", "ix_agents_supervisor_user_id"),
    ("ix_auth_sessions_user_id", "ix_auth_sessions_account_id"),
    ("ix_auth_users_employee_id", "ix_auth_accounts_user_id"),
    ("ix_auth_users_role", "ix_auth_accounts_role"),
    ("ix_daemon_nodes_employee_id", "ix_daemon_nodes_user_id"),
    ("ix_employees_department_id", "ix_users_department_id"),
    ("uq_employees_handle", "uq_users_handle"),
    ("ix_session_run_token_usage_owner_employee_id", "ix_session_run_token_usage_owner_user_id"),
    ("ix_teams_owner_employee_id", "ix_teams_owner_user_id"),
)

# (table after the table rename, old constraint, new constraint)
CONSTRAINTS = (
    ("agent_events", "uq_employee_agent_events_sequence", "uq_user_agent_events_sequence"),
    ("agent_placements", "fk_agent_placements_supervisor_employee", "fk_agent_placements_supervisor_user"),
    ("agents", "fk_agents_supervisor_employee", "fk_agents_supervisor_user"),
    ("auth_accounts", "ck_auth_users_role", "ck_auth_accounts_role"),
    ("daemon_nodes", "fk_daemon_nodes_employee", "fk_daemon_nodes_user"),
    ("teams", "fk_teams_owner_employee", "fk_teams_owner_user"),
)

# Applied in order to names Postgres generated: the agents tables were once
# "employee_agents", so their generated names drop the prefix entirely.
GENERATED_NAME_RULES = (
    ("auth_sessions_user_id", "auth_sessions_account_id"),
    ("auth_users", "auth_accounts"),
    ("employee_agent", "agent"),
    ("employees", "users"),
    ("employee", "user"),
)

SKILL_TARGET_CHECK = "ck_skill_assignments_target_type"


def upgrade() -> None:
    for old, new in TABLES:
        op.rename_table(old, new)
    for table, old, new in COLUMNS:
        op.alter_column(table, old, new_column_name=new)
    for old, new in INDEXES:
        op.execute(f'ALTER INDEX "{old}" RENAME TO "{new}"')
    for table, old, new in CONSTRAINTS:
        op.execute(f'ALTER TABLE "{table}" RENAME CONSTRAINT "{old}" TO "{new}"')
    _retarget_skill_assignments("employee", "user")
    op.execute(
        "UPDATE daemon_nodes SET node_location = 'user-device' "
        "WHERE node_location = 'employee-device'"
    )
    _rename_generated_names()


def downgrade() -> None:
    # Generated names keep their new spelling: nothing references them, and the
    # rule that produced them cannot be inverted without guessing.
    op.execute(
        "UPDATE daemon_nodes SET node_location = 'employee-device' "
        "WHERE node_location = 'user-device'"
    )
    _retarget_skill_assignments("user", "employee")
    for table, old, new in reversed(CONSTRAINTS):
        op.execute(f'ALTER TABLE "{table}" RENAME CONSTRAINT "{new}" TO "{old}"')
    for old, new in reversed(INDEXES):
        op.execute(f'ALTER INDEX "{new}" RENAME TO "{old}"')
    for table, old, new in reversed(COLUMNS):
        op.alter_column(table, new, new_column_name=old)
    for old, new in reversed(TABLES):
        op.rename_table(new, old)


def _retarget_skill_assignments(old: str, new: str) -> None:
    op.drop_constraint(SKILL_TARGET_CHECK, "skill_assignments", type_="check")
    op.execute(
        sa.text("UPDATE skill_assignments SET target_type = :new WHERE target_type = :old")
        .bindparams(new=new, old=old)
    )
    op.create_check_constraint(
        SKILL_TARGET_CHECK,
        "skill_assignments",
        f"target_type IN ('{new}', 'team', 'project', 'agent', 'org')",
    )


def _rename_generated_names() -> None:
    conn = op.get_bind()
    taken = set(
        conn.execute(
            sa.text(
                "SELECT c.relname FROM pg_class c "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = current_schema()"
            )
        ).scalars()
    )
    constraints = conn.execute(
        sa.text(
            "SELECT con.conname, rel.relname, con.conindid FROM pg_constraint con "
            "JOIN pg_class rel ON rel.oid = con.conrelid "
            "JOIN pg_namespace n ON n.oid = rel.relnamespace "
            "WHERE n.nspname = current_schema()"
        )
    ).all()
    taken |= {name for name, _table, _index in constraints}
    for name, table, _index in constraints:
        new = _renamed(name)
        if new != name and new not in taken:
            op.execute(f'ALTER TABLE "{table}" RENAME CONSTRAINT "{name}" TO "{new}"')
            taken |= {new}
    # Indexes that back no constraint (a constraint rename already moved its own).
    indexes = conn.execute(
        sa.text(
            "SELECT idx.relname FROM pg_index i "
            "JOIN pg_class idx ON idx.oid = i.indexrelid "
            "JOIN pg_namespace n ON n.oid = idx.relnamespace "
            "WHERE n.nspname = current_schema() "
            "AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)"
        )
    ).scalars()
    for name in list(indexes):
        new = _renamed(name)
        if new != name and new not in taken:
            op.execute(f'ALTER INDEX "{name}" RENAME TO "{new}"')
            taken |= {new}


def _renamed(name: str) -> str:
    for old, new in GENERATED_NAME_RULES:
        name = re.sub(old, new, name)
    return name
