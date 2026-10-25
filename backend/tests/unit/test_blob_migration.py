"""relay migrate-blobs-to-r2: move bytes already stored elsewhere into the blob store."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from blob_fakes import MemoryBlobStore
from relay.ops.blob_migration import migrate_blobs
from relay.persistence.session.store import DatabaseSessionStore
from relay.persistence.skill.objects import LocalSkillObjectStore
from relay.persistence.skill.store import DatabaseSkillStore
from sqlalchemy import insert, select

ARTIFACT_ID = "22222222-2222-4222-8222-222222222222"
SNAPSHOT = b"%PDF-1.7 \x00 report"
LEGACY_SKILL = b"legacy skill bytes in the database"
LOCAL_SKILL = b"skill bytes in the data dir"


def _digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _skill_key(content: bytes) -> str:
    digest = _digest(content)
    return f"skills/objects/{digest[:2]}/{digest[2:]}"


@pytest.fixture
def database_url(tmp_path: Path) -> str:
    return f"sqlite:///{tmp_path}/relay.db"


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    return tmp_path / "data"


@pytest.fixture
def seeded(database_url: str, data_dir: Path) -> dict:
    """One inline artifact snapshot, one legacy database skill blob, one data-dir skill object."""
    sessions = DatabaseSessionStore(database_url, create_schema=True)
    session = sessions.create_session(
        {"workspacePath": "/workspace", "taskGoal": "report", "participants": ["human", "codex"]}
    )
    sessions.index_workspace_artifact(
        session["id"],
        {
            "id": ARTIFACT_ID,
            "kind": "workspace_file",
            "title": "report.pdf",
            "path": f"/workspace/{session['id']}/report.pdf",
            "createdAt": "2026-07-01T00:00:00.000Z",
            "agentRunId": "run_1",
            "bytes": len(SNAPSHOT),
            "contentType": "application/pdf",
            "workspaceRelativePath": "report.pdf",
        },
        SNAPSHOT,
    )
    local = LocalSkillObjectStore(data_dir / "skills" / "objects")
    skills = DatabaseSkillStore(database_url, object_store=local)
    with skills.engine.begin() as conn:
        conn.execute(
            insert(skills.blobs).values(
                sha256=_digest(LEGACY_SKILL), content=LEGACY_SKILL, bytes=len(LEGACY_SKILL)
            )
        )
    local.put(_digest(LOCAL_SKILL), LOCAL_SKILL)
    return {"session_id": session["id"], "sessions": sessions, "skills": skills}


def test_moves_every_kind_of_stored_bytes(database_url, data_dir, seeded) -> None:
    blobs = MemoryBlobStore()

    report = migrate_blobs(database_url, blobs, data_dir=data_dir)

    assert report == {
        "dryRun": False,
        "artifactSnapshots": 1,
        "skippedArtifactSnapshots": 0,
        "databaseSkillObjects": 1,
        "dataDirSkillObjects": 1,
    }
    artifact_key = f"session-artifacts/{seeded['session_id']}/{ARTIFACT_ID}"
    assert blobs.blobs == {
        artifact_key: SNAPSHOT,
        _skill_key(LEGACY_SKILL): LEGACY_SKILL,
        _skill_key(LOCAL_SKILL): LOCAL_SKILL,
    }

    sessions = seeded["sessions"]
    with sessions.engine.connect() as conn:
        row = conn.execute(
            select(sessions.artifacts.c.content, sessions.artifacts.c.metadata)
        ).mappings().one()
    assert row["content"] is None
    assert row["metadata"]["blobKey"] == artifact_key
    assert row["metadata"]["sha256"] == _digest(SNAPSHOT)
    assert "contentEncoding" not in row["metadata"]

    skills = seeded["skills"]
    with skills.engine.connect() as conn:
        assert conn.scalar(select(skills.blobs.c.content)) is None

    # The migrated rows read back through the blob store.
    reader = DatabaseSessionStore(database_url, blob_store=blobs)
    assert reader.read_artifact_content(seeded["session_id"], ARTIFACT_ID) == SNAPSHOT


def test_dry_run_counts_without_changing_anything(database_url, data_dir, seeded) -> None:
    blobs = MemoryBlobStore()

    report = migrate_blobs(database_url, blobs, data_dir=data_dir, dry_run=True)

    assert report["dryRun"] is True
    assert (report["artifactSnapshots"], report["databaseSkillObjects"], report["dataDirSkillObjects"]) == (1, 1, 1)
    assert blobs.blobs == {}
    assert seeded["sessions"].read_artifact_content(seeded["session_id"], ARTIFACT_ID) == SNAPSHOT


def test_a_second_run_has_nothing_left_to_move(database_url, data_dir, seeded) -> None:
    blobs = MemoryBlobStore()
    migrate_blobs(database_url, blobs, data_dir=data_dir)
    blobs.puts.clear()

    report = migrate_blobs(database_url, blobs, data_dir=data_dir)

    assert (report["artifactSnapshots"], report["databaseSkillObjects"]) == (0, 0)
    # Data-dir objects already in the store are counted as present, not re-uploaded.
    assert report["dataDirSkillObjects"] == 0
    assert blobs.puts == []


def test_without_a_data_dir_only_database_bytes_move(database_url, seeded) -> None:
    report = migrate_blobs(database_url, MemoryBlobStore())
    assert report["dataDirSkillObjects"] == 0
    assert report["artifactSnapshots"] == 1


def test_an_upload_failure_leaves_the_row_untouched(database_url, data_dir, seeded) -> None:
    class Failing(MemoryBlobStore):
        def put(self, key: str, data: bytes, *, content_type: str | None) -> None:
            raise ConnectionError("r2 unreachable")

    with pytest.raises(ConnectionError):
        migrate_blobs(database_url, Failing(), data_dir=data_dir)

    assert seeded["sessions"].read_artifact_content(seeded["session_id"], ARTIFACT_ID) == SNAPSHOT


def test_a_corrupt_inline_snapshot_is_skipped_not_uploaded(database_url, seeded) -> None:
    sessions = seeded["sessions"]
    with sessions.engine.begin() as conn:
        conn.execute(sessions.artifacts.update().values(content="not base64!!"))
    blobs = MemoryBlobStore()

    report = migrate_blobs(database_url, blobs)

    assert report["artifactSnapshots"] == 0
    assert report["skippedArtifactSnapshots"] == 1
    assert not any(key.startswith("session-artifacts/") for key in blobs.blobs)
