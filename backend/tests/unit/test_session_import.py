from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import update

from relay.persistence.session_import import migrate_local_sessions
from relay.persistence.session_store import DatabaseSessionStore, LocalSessionStore
from relay.persistence.store_common import now_iso, relay_event


def test_import_uses_event_log_and_is_idempotent(tmp_path: Path) -> None:
    source = tmp_path / "legacy"
    local = LocalSessionStore(source)
    created = local.create_session(
        {
            "workspacePath": "/workspace",
            "ownerUserId": "alice",
            "taskGoal": "migrate me",
            "participants": ["human"],
        }
    )
    lost = relay_event(
        "human.decision",
        created["id"],
        {
            "decision": {
                "id": "dec_lost",
                "kind": "approve",
                "createdAt": now_iso(),
            }
        },
    )
    events_path = source / "sessions" / created["id"] / "events.jsonl"
    with events_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(lost) + "\n")

    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )
    first = migrate_local_sessions(source, database)
    second = migrate_local_sessions(source, database)

    assert first["imported"] == 1
    assert any("snapshot drift" in item["message"] for item in first["warnings"])
    assert database.get_session(created["id"])["decisions"][0]["id"] == "dec_lost"
    assert second["skipped"] == 1
    assert first["importedIds"] == [created["id"]]
    assert second["skippedIds"] == [created["id"]]
    assert first["totals"]["events"] == 2
    assert first["sessions"][0]["payloadHash"]


def test_import_rejects_divergent_existing_session(tmp_path: Path) -> None:
    source = tmp_path / "legacy"
    local = LocalSessionStore(source)
    created = local.create_session(
        {"workspacePath": "/workspace", "taskGoal": "legacy", "participants": ["human"]}
    )
    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )
    database.import_session(created["events"], {})
    local.append_event(
        created["id"], relay_event("session.renamed", created["id"], {"title": "new"})
    )

    report = migrate_local_sessions(source, database)

    assert report["failures"]
    assert "divergent history" in report["failures"][0]["message"]


def test_import_dry_run_checks_database_conflicts(tmp_path: Path) -> None:
    source = tmp_path / "legacy"
    local = LocalSessionStore(source)
    created = local.create_session(
        {"workspacePath": "/workspace", "taskGoal": "legacy", "participants": ["human"]}
    )
    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )
    database.import_session(created["events"], {})
    local.append_event(
        created["id"], relay_event("session.renamed", created["id"], {"title": "new"})
    )
    with database.engine.begin() as conn:
        conn.execute(
            update(database.sessions)
            .where(database.sessions.c.id == created["id"])
            .values(snapshot=local.get_session(created["id"]))
        )

    report = migrate_local_sessions(source, database, dry_run=True)

    assert report["validated"] == 0
    assert report["failures"]
    assert "divergent history" in report["failures"][0]["message"]


def test_import_dry_run_validates_without_writing(tmp_path: Path) -> None:
    source = tmp_path / "legacy"
    local = LocalSessionStore(source)
    created = local.create_session(
        {"workspacePath": "/workspace", "taskGoal": "legacy", "participants": ["human"]}
    )
    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )

    report = migrate_local_sessions(source, database, dry_run=True)

    assert report["validated"] == 1
    with pytest.raises(KeyError):
        database.get_session(created["id"])


def test_import_blocks_missing_retained_artifact_content(tmp_path: Path) -> None:
    source = tmp_path / "legacy"
    local = LocalSessionStore(source)
    created = local.create_session(
        {"workspacePath": "/workspace", "taskGoal": "legacy", "participants": ["human"]}
    )
    artifact, _session = local.create_artifact(
        created["id"],
        {"kind": "review", "title": "review.md", "body": "keep me", "extension": "md"},
    )
    Path(artifact["path"]).unlink()
    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )

    report = migrate_local_sessions(source, database)

    assert report["imported"] == 0
    assert "retained content is missing" in report["failures"][0]["message"]


def test_import_blocks_truncated_retained_artifact_content(tmp_path: Path) -> None:
    source = tmp_path / "legacy"
    local = LocalSessionStore(source)
    created = local.create_session(
        {"workspacePath": "/workspace", "taskGoal": "legacy", "participants": ["human"]}
    )
    artifact, _session = local.create_artifact(
        created["id"],
        {"kind": "review", "title": "review.md", "body": "keep me", "extension": "md"},
    )
    Path(artifact["path"]).write_text("x", encoding="utf-8")
    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )

    report = migrate_local_sessions(source, database, dry_run=True)

    assert report["validated"] == 0
    assert "retained content size mismatch" in report["failures"][0]["message"]


def test_import_dry_run_rejects_duplicate_artifact_ids(tmp_path: Path) -> None:
    source = tmp_path / "legacy"
    local = LocalSessionStore(source)
    created = local.create_session(
        {"workspacePath": "/workspace", "taskGoal": "legacy", "participants": ["human"]}
    )
    artifact, _session = local.create_artifact(
        created["id"],
        {"kind": "review", "title": "review.md", "body": "keep me", "extension": "md"},
    )
    local.append_event(
        created["id"],
        relay_event("artifact.created", created["id"], {"artifact": artifact}),
    )
    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )

    report = migrate_local_sessions(source, database, dry_run=True)

    assert report["validated"] == 0
    assert "duplicate artifact IDs" in report["failures"][0]["message"]


def test_import_dry_run_rejects_event_ids_reused_across_sessions(
    tmp_path: Path,
) -> None:
    source = tmp_path / "legacy"
    local = LocalSessionStore(source)
    first = local.create_session(
        {"workspacePath": "/workspace", "taskGoal": "first", "participants": ["human"]}
    )
    second = local.create_session(
        {"workspacePath": "/workspace", "taskGoal": "second", "participants": ["human"]}
    )
    second_events_path = source / "sessions" / second["id"] / "events.jsonl"
    second_events = [
        json.loads(line)
        for line in second_events_path.read_text(encoding="utf-8").splitlines()
        if line
    ]
    second_events[0]["id"] = first["events"][0]["id"]
    second_events_path.write_text(
        "".join(json.dumps(event) + "\n" for event in second_events),
        encoding="utf-8",
    )
    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )

    report = migrate_local_sessions(source, database, dry_run=True)

    assert report["validated"] == 1
    assert "reused across legacy sessions" in report["failures"][0]["message"]


def test_import_dry_run_executes_database_constraints(tmp_path: Path) -> None:
    source = tmp_path / "legacy"
    local = LocalSessionStore(source)
    created = local.create_session(
        {"workspacePath": "/workspace", "taskGoal": "legacy", "participants": ["human"]}
    )
    local.create_artifact(
        created["id"],
        {"kind": "review", "title": "review.md", "body": "keep me", "extension": "md"},
    )
    events_path = source / "sessions" / created["id"] / "events.jsonl"
    events = [
        json.loads(line)
        for line in events_path.read_text(encoding="utf-8").splitlines()
        if line
    ]
    artifact_event = next(event for event in events if event["type"] == "artifact.created")
    artifact_event["artifact"]["id"] = None
    events_path.write_text(
        "".join(json.dumps(event) + "\n" for event in events),
        encoding="utf-8",
    )
    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )

    report = migrate_local_sessions(source, database, dry_run=True)

    assert report["validated"] == 0
    assert report["failures"]
    with pytest.raises(KeyError):
        database.get_session(created["id"])


def test_import_reserves_ids_from_sessions_that_fail_later(tmp_path: Path) -> None:
    source = tmp_path / "legacy"
    sessions_dir = source / "sessions"
    first_dir = sessions_dir / "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    second_dir = sessions_dir / "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    first_dir.mkdir(parents=True)
    second_dir.mkdir(parents=True)
    timestamp = "2026-07-27T00:00:00.000Z"
    first_events = [
        {
            "id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            "type": "session.created",
            "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "timestamp": timestamp,
            "workspacePath": "/workspace",
            "taskGoal": "broken artifact",
            "participants": ["human"],
        },
        {
            "id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
            "type": "artifact.created",
            "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "timestamp": timestamp,
            "artifact": {
                "id": "44444444-4444-4444-8444-444444444444",
                "kind": "review",
                "title": "missing.md",
                "path": str(first_dir / "artifacts" / "missing.md"),
                "createdAt": timestamp,
                "bytes": 10,
            },
        },
    ]
    second_events = [
        {
            "id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            "type": "session.created",
            "sessionId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "timestamp": timestamp,
            "workspacePath": "/workspace",
            "taskGoal": "reused id",
            "participants": ["human"],
        }
    ]
    for path, events in (
        (first_dir / "events.jsonl", first_events),
        (second_dir / "events.jsonl", second_events),
    ):
        path.write_text(
            "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
        )
    database = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True
    )

    report = migrate_local_sessions(source, database, dry_run=True)

    assert report["validated"] == 0
    assert len(report["failures"]) == 2
    assert "retained content is missing" in report["failures"][0]["message"]
    assert "reused across legacy sessions" in report["failures"][1]["message"]
