"""Visibility migration preserves private access and event-authoritative replay."""

import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import JSON, Column, DateTime, Integer, MetaData, Table, Text, CheckConstraint, create_engine, insert, select
from sqlalchemy.exc import IntegrityError
import pytest

from relay.core.ids import now_iso
from relay.persistence.db_time import parse_db_time
from relay.persistence.skill.events import SkillEventRows

MIGRATION = Path(__file__).parents[2] / "migrations/versions/20261112_0124_public_skill_visibility.py"


def test_visibility_migration_updates_projection_and_appends_replayable_events():
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    metadata = MetaData()
    skills = Table("skills", metadata,
        Column("id", Text, primary_key=True), Column("visibility", Text, nullable=False),
        Column("snapshot", JSON, nullable=False), Column("event_version", Integer, nullable=False),
        CheckConstraint("visibility IN ('private', 'org')", name="ck_skills_visibility"))
    events = Table("skill_events", metadata,
        Column("id", Text, primary_key=True), Column("skill_id", Text, nullable=False),
        Column("sequence", Integer, nullable=False), Column("type", Text, nullable=False),
        Column("timestamp", DateTime, nullable=False), Column("payload", JSON, nullable=False))
    engine = create_engine("sqlite:///:memory:")
    metadata.create_all(engine)
    reader = SkillEventRows()
    reader.events_table = events
    timestamp = now_iso()
    originals = {}
    with engine.begin() as conn:
        for name, visibility, deleted in [("shared", "org", False), ("secret", "private", False),
                                           ("deleted", "org", True)]:
            snapshot = {"id": name, "visibility": visibility, "updatedAt": timestamp,
                        "deletedAt": timestamp if deleted else None}
            payload = {"skill": snapshot}
            originals[name] = payload
            conn.execute(insert(skills).values(id=name, visibility=visibility, snapshot=snapshot, event_version=1))
            conn.execute(insert(events).values(id=name, skill_id=name, sequence=0, type="skill.created",
                         timestamp=parse_db_time(timestamp), payload=payload))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
            rows = conn.execute(select(skills)).mappings().all()
            for row in rows:
                expected = "private" if row["id"] == "secret" else "public"
                assert row["visibility"] == row["snapshot"]["visibility"] == expected
                assert reader._replay(conn, row["id"]) == row["snapshot"]
                assert row["event_version"] == (1 if expected == "private" else 2)
            # The old audit records stay intact; only a new visibility event is added.
            for name, payload in originals.items():
                assert conn.scalar(select(events.c.payload).where(events.c.id == name)) == payload
            with pytest.raises(IntegrityError), conn.begin_nested():
                conn.execute(insert(skills).values(id="old", visibility="org", snapshot={}, event_version=0))
            module.downgrade()
            for row in conn.execute(select(skills)).mappings():
                expected = "private" if row["id"] == "secret" else "org"
                assert row["visibility"] == row["snapshot"]["visibility"] == expected
                assert reader._replay(conn, row["id"]) == row["snapshot"]
            with pytest.raises(IntegrityError), conn.begin_nested():
                conn.execute(insert(skills).values(id="new", visibility="public", snapshot={}, event_version=0))
