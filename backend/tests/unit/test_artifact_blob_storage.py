"""Workspace-artifact snapshots kept in a blob store instead of Postgres."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from blob_fakes import MemoryBlobStore
from relay.persistence.session_store import DatabaseSessionStore
from sqlalchemy import text

ARTIFACT_ID = "22222222-2222-4222-8222-222222222222"
CONTENT = b"pptx binary \x00 bytes"


def _artifact(session_id: str, artifact_id: str = ARTIFACT_ID) -> dict:
    return {
        "id": artifact_id,
        "kind": "workspace_file",
        "title": "deck.pptx",
        "path": f"/workspace/{session_id}/deck.pptx",
        "createdAt": "2026-07-01T00:00:00.000Z",
        "agentRunId": "run_1",
        "bytes": 10,
        "contentType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "workspaceRelativePath": "deck.pptx",
    }


@pytest.fixture
def blobs() -> MemoryBlobStore:
    return MemoryBlobStore()


@pytest.fixture
def store(tmp_path: Path, blobs: MemoryBlobStore) -> DatabaseSessionStore:
    return DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True, blob_store=blobs
    )


def _session(store: DatabaseSessionStore) -> dict:
    return store.create_session(
        {"workspacePath": "/workspace", "taskGoal": "build a deck", "participants": ["human", "codex"]}
    )


def _row(store: DatabaseSessionStore, artifact_id: str = ARTIFACT_ID) -> dict:
    with store.engine.begin() as conn:
        row = dict(
            conn.execute(
                text("select content, metadata from session_artifacts where id = :id"),
                {"id": artifact_id},
            ).mappings().one()
        )
    if isinstance(row["metadata"], str):
        row["metadata"] = json.loads(row["metadata"])
    return row


def test_snapshot_goes_to_the_blob_store_not_the_database(store, blobs) -> None:
    session = _session(store)
    artifact, _ = store.index_workspace_artifact(session["id"], _artifact(session["id"]), CONTENT)

    row = _row(store)
    assert row["content"] is None
    assert row["metadata"]["blobKey"] == f"session-artifacts/{session['id']}/{ARTIFACT_ID}"
    assert len(row["metadata"]["sha256"]) == 64
    assert "contentEncoding" not in row["metadata"]
    assert artifact["bytes"] == len(CONTENT)
    assert blobs.blobs == {row["metadata"]["blobKey"]: CONTENT}
    assert store.read_artifact_content(session["id"], ARTIFACT_ID) == CONTENT


def test_metadata_only_artifacts_write_no_blob(store, blobs) -> None:
    session = _session(store)
    store.index_workspace_artifact(session["id"], _artifact(session["id"]), None)
    assert blobs.blobs == {}
    assert store.read_artifact_content(session["id"], ARTIFACT_ID) is None


def test_a_tampered_blob_is_not_served(store, blobs) -> None:
    session = _session(store)
    store.index_workspace_artifact(session["id"], _artifact(session["id"]), CONTENT)
    key = next(iter(blobs.blobs))
    blobs.blobs[key] = b"something else"
    assert store.read_artifact_content(session["id"], ARTIFACT_ID) is None


def test_a_missing_blob_reads_as_no_snapshot(store, blobs) -> None:
    session = _session(store)
    store.index_workspace_artifact(session["id"], _artifact(session["id"]), CONTENT)
    blobs.blobs.clear()
    assert store.read_artifact_content(session["id"], ARTIFACT_ID) is None


def test_failed_index_removes_the_uploaded_blob(store, blobs) -> None:
    with pytest.raises(KeyError):
        store.index_workspace_artifact(
            "00000000-0000-4000-8000-000000000000",
            _artifact("missing"),
            CONTENT,
        )
    assert blobs.blobs == {}


def test_an_unreachable_blob_store_keeps_the_snapshot_inline(store, blobs, monkeypatch) -> None:
    # A missing bucket or an R2 outage must not wedge run finalization: the
    # reaper would retry the same terminal event forever.
    def refuse(*_args, **_kwargs):
        raise RuntimeError("NoSuchBucket: The specified bucket does not exist.")

    monkeypatch.setattr(blobs, "put", refuse)
    session = _session(store)
    artifact, _ = store.index_workspace_artifact(session["id"], _artifact(session["id"]), CONTENT)

    row = _row(store)
    assert "blobKey" not in row["metadata"]
    assert row["metadata"]["contentEncoding"] == "base64"
    assert artifact["bytes"] == len(CONTENT)
    assert store.read_artifact_content(session["id"], ARTIFACT_ID) == CONTENT


def test_deleting_a_session_deletes_its_blobs(store, blobs) -> None:
    keep = _session(store)
    doomed = _session(store)
    store.index_workspace_artifact(keep["id"], _artifact(keep["id"]), CONTENT)
    store.index_workspace_artifact(
        doomed["id"], _artifact(doomed["id"], "33333333-3333-4333-8333-333333333333"), CONTENT
    )

    store.delete_session(doomed["id"])

    assert list(blobs.blobs) == [f"session-artifacts/{keep['id']}/{ARTIFACT_ID}"]


@pytest.mark.parametrize("commit", [False, True])
def test_session_blob_cleanup_waits_for_outer_commit(store, blobs, commit) -> None:
    from relay.persistence.store_common import store_transaction

    session = _session(store)
    store.index_workspace_artifact(session["id"], _artifact(session["id"]), CONTENT)
    try:
        with store_transaction(store.engine):
            store.delete_session(session["id"])
            assert blobs.blobs
            if not commit:
                raise RuntimeError("abort outer operation")
    except RuntimeError:
        pass
    if commit:
        assert blobs.blobs == {}
    else:
        assert store.read_artifact_content(session["id"], ARTIFACT_ID) == CONTENT


def test_inline_snapshots_still_read_after_the_blob_store_is_enabled(tmp_path, blobs) -> None:
    url = f"sqlite:///{tmp_path}/relay.db"
    inline = DatabaseSessionStore(url, create_schema=True)
    session = _session(inline)
    inline.index_workspace_artifact(session["id"], _artifact(session["id"]), CONTENT)

    with_blobs = DatabaseSessionStore(url, blob_store=blobs)
    assert with_blobs.read_artifact_content(session["id"], ARTIFACT_ID) == CONTENT


def test_blob_snapshots_read_as_missing_without_a_blob_store(tmp_path, blobs) -> None:
    url = f"sqlite:///{tmp_path}/relay.db"
    with_blobs = DatabaseSessionStore(url, create_schema=True, blob_store=blobs)
    session = _session(with_blobs)
    with_blobs.index_workspace_artifact(session["id"], _artifact(session["id"]), CONTENT)

    # Turning the blob store off must not crash downloads; the route falls back
    # to reading the file live from the computer.
    without = DatabaseSessionStore(url)
    assert without.read_artifact_content(session["id"], ARTIFACT_ID) is None
