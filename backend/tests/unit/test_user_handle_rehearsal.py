"""The backfill plan the rehearsal command prints — the same rule the migration
applies, so a dry run cannot disagree with the real thing."""

from __future__ import annotations

from relay.cli import rehearse_user_handles
from relay.ops.handle_backfill import plan_handles, summarize
from sqlalchemy import create_engine, text


def test_plan_reports_the_source_and_every_collision() -> None:
    users = [
        {"id": "id-1", "display_name": "Alice Chen"},
        {"id": "id-2", "display_name": "Bob Stone"},
        {"id": "id-3", "display_name": "Bob Stone"},
        {"id": "deadbeefcafe", "display_name": "///"},
    ]
    plan = plan_handles(users, {"id-1": "alice"})

    assert [row["handle"] for row in plan] == [
        "alice",
        "bob-stone",
        "bob-stone-2",
        "deadbeef",
    ]
    assert [row["source"] for row in plan] == [
        "username",
        "display_name",
        "display_name",
        "id_prefix",
    ]

    report = summarize(plan)
    assert report["users"] == 4
    assert report["bySource"] == {"username": 1, "display_name": 2, "id_prefix": 1}
    assert report["suffixed"] == 1
    # The rows an operator has to look at before applying: one renamed to
    # something nobody would recognize, one disambiguated.
    assert [row["id"] for row in report["unrecognizable"]] == ["deadbeefcafe"]
    assert [row["id"] for row in report["collisions"]] == ["id-3"]


def test_rehearsal_reads_a_real_database_and_writes_nothing(tmp_path) -> None:
    url = f"sqlite:///{tmp_path}/rehearsal.db"
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE users (id TEXT PRIMARY KEY, "
                "display_name TEXT NOT NULL, created_at TIMESTAMP NOT NULL)"
            )
        )
        connection.execute(
            text("CREATE TABLE auth_accounts (username TEXT NOT NULL, user_id TEXT)")
        )
        connection.execute(
            text(
                "INSERT INTO users VALUES ('id-1', 'Alice Chen', '2026-01-01'), "
                "('id-2', 'Alice Chen', '2026-01-02')"
            )
        )
        connection.execute(text("INSERT INTO auth_accounts VALUES ('alice', 'id-1')"))

    report = rehearse_user_handles(url)
    assert [row["handle"] for row in report["plan"]] == ["alice", "alice-chen"]
    assert report["suffixed"] == 0

    # Reads only — the column it is planning does not exist yet, and the
    # rehearsal must not have created or populated one.
    with engine.connect() as connection:
        columns = {
            row["name"]
            for row in connection.execute(text("PRAGMA table_info('users')")).mappings()
        }
    assert "handle" not in columns
