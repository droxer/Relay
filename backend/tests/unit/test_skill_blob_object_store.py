"""Skill bundle objects kept in a blob store (R2) instead of the data dir."""

from __future__ import annotations

import hashlib

import pytest
from blob_fakes import MemoryBlobStore
from relay.persistence.skill_object_store import BlobSkillObjectStore, LocalSkillObjectStore

CONTENT = b"---\nname: demo\n---\nskill body\n"
DIGEST = hashlib.sha256(CONTENT).hexdigest()
KEY = f"skills/objects/{DIGEST[:2]}/{DIGEST[2:]}"


def test_round_trip_is_content_addressed() -> None:
    blobs = MemoryBlobStore()
    store = BlobSkillObjectStore(blobs)
    store.put(DIGEST, CONTENT)
    assert blobs.blobs == {KEY: CONTENT}
    assert store.exists(DIGEST) is True
    assert store.get(DIGEST) == CONTENT


def test_put_rejects_content_that_does_not_match_its_digest() -> None:
    with pytest.raises(ValueError):
        BlobSkillObjectStore(MemoryBlobStore()).put(DIGEST, b"other bytes")


def test_put_rejects_a_malformed_digest() -> None:
    with pytest.raises(ValueError):
        BlobSkillObjectStore(MemoryBlobStore()).put("../etc/passwd", CONTENT)


def test_put_skips_an_object_that_is_already_stored() -> None:
    blobs = MemoryBlobStore()
    store = BlobSkillObjectStore(blobs)
    store.put(DIGEST, CONTENT)
    store.put(DIGEST, CONTENT)
    assert blobs.puts == [KEY]


def test_missing_object_reads_as_none() -> None:
    store = BlobSkillObjectStore(MemoryBlobStore())
    assert store.get(DIGEST) is None
    assert store.exists(DIGEST) is False


def test_a_corrupted_object_fails_verification() -> None:
    blobs = MemoryBlobStore()
    blobs.blobs[KEY] = b"tampered"
    with pytest.raises(OSError):
        BlobSkillObjectStore(blobs).get(DIGEST)


def test_reads_fall_back_to_the_data_dir_and_copy_up(tmp_path) -> None:
    local = LocalSkillObjectStore(tmp_path / "skills" / "objects")
    local.put(DIGEST, CONTENT)
    blobs = MemoryBlobStore()
    store = BlobSkillObjectStore(blobs, fallback=local)

    assert store.exists(DIGEST) is True
    assert store.get(DIGEST) == CONTENT
    # Copied up, so the data dir can go once every object has moved.
    assert blobs.blobs == {KEY: CONTENT}


def test_new_writes_never_touch_the_fallback(tmp_path) -> None:
    local = LocalSkillObjectStore(tmp_path / "skills" / "objects")
    BlobSkillObjectStore(MemoryBlobStore(), fallback=local).put(DIGEST, CONTENT)
    assert local.exists(DIGEST) is False


def test_app_shares_one_blob_store_between_snapshots_and_skills(monkeypatch, tmp_path) -> None:
    import relay.app as app_module

    blobs = MemoryBlobStore()
    monkeypatch.setattr(app_module, "blob_store_from_env", lambda: blobs)

    app = app_module.create_app(tmp_path / "data")

    object_store = app.state.skill_store.object_store
    assert isinstance(object_store, BlobSkillObjectStore)
    assert object_store.blob_store is blobs
    assert isinstance(object_store.fallback, LocalSkillObjectStore)
    assert object_store.fallback.root == tmp_path / "data" / "skills" / "objects"
    assert app.state.session_store.blob_store is blobs


def test_app_keeps_skills_in_the_data_dir_without_a_blob_store(tmp_path) -> None:
    from relay.app import create_app

    app = create_app(tmp_path / "data")
    assert isinstance(app.state.skill_store.object_store, LocalSkillObjectStore)
    assert app.state.session_store.blob_store is None


def test_published_skill_bundles_round_trip_through_the_blob_store(tmp_path) -> None:
    from uuid import uuid4

    from relay.core.ids import now_iso
    from relay.persistence.skill_store import DatabaseSkillStore
    from relay.persistence.store_common import _parse_iso
    from sqlalchemy import insert

    blobs = MemoryBlobStore()
    local = LocalSkillObjectStore(tmp_path / "data" / "skills" / "objects")
    store = DatabaseSkillStore(
        f"sqlite:///{tmp_path}/relay.db",
        create_schema=True,
        object_store=BlobSkillObjectStore(blobs, fallback=local),
    )
    owner = str(uuid4())
    with store.engine.begin() as conn:
        conn.execute(
            insert(store.users).values(
                id=owner, handle="alice", display_name="Alice", email=None,
                department_id=None, max_local_computers=None,
                created_at=_parse_iso(now_iso()), updated_at=_parse_iso(now_iso()), deleted_at=None,
            )
        )
    manifest = b"---\nname: review\ndescription: Reviews code\n---\nBody"
    skill = store.create_skill(
        owner,
        {"name": "review", "visibility": "private", "source": "authored",
         "files": [{"path": "SKILL.md", "content": manifest}]},
    )

    [file] = store.revision_files(skill["currentRevisionId"])
    assert store.blob(file["sha256"]) == manifest
    assert BlobSkillObjectStore.key_for(file["sha256"]) in blobs.blobs
    assert not local.root.exists()
