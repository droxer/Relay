"""Rename organization-visible skill publications to public.

Revision ID: 20261112_0124
Revises: 20261110_0123

Stop old application writers before migrating and deploy the new backend and
web client together: the accepted visibility values change to private/public.
The audience is unchanged. Append visibility events instead of rewriting history;
keep the existing update timestamps because this is a vocabulary change.
Downgrade appends the reverse events and restores private/org validation.
"""
from uuid import uuid4

from alembic import op
import sqlalchemy as sa

revision = "20261112_0124"
down_revision = "20261110_0123"
branch_labels = None
depends_on = None


def _rename_visibility(old, new):
    conn = op.get_bind()
    metadata = sa.MetaData()
    skills = sa.Table("skills", metadata, autoload_with=conn)
    events = sa.Table("skill_events", metadata, autoload_with=conn)
    with op.batch_alter_table("skills") as batch:
        batch.drop_constraint("ck_skills_visibility", type_="check")
        batch.create_check_constraint(
            "ck_skills_visibility", f"visibility IN ('private', '{old}', '{new}')"
        )
    rows = conn.execute(sa.select(skills).where(skills.c.visibility == old)).mappings()
    for row in rows:
        snapshot = {**row["snapshot"], "visibility": new}
        event_id = uuid4()
        conn.execute(sa.insert(events).values(
            id=event_id if conn.dialect.name == "postgresql" else str(event_id),
            skill_id=row["id"], sequence=row["event_version"], type="skill.updated",
            timestamp=sa.func.now(),
            payload={"patch": {"visibility": new}, "updatedAt": snapshot["updatedAt"]},
        ))
        conn.execute(sa.update(skills).where(skills.c.id == row["id"]).values(
            visibility=new, snapshot=snapshot, event_version=row["event_version"] + 1,
        ))
    with op.batch_alter_table("skills") as batch:
        batch.drop_constraint("ck_skills_visibility", type_="check")
        batch.create_check_constraint("ck_skills_visibility", f"visibility IN ('private', '{new}')")


def upgrade():
    _rename_visibility("org", "public")


def downgrade():
    _rename_visibility("public", "org")
