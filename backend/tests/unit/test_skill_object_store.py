from __future__ import annotations

import hashlib
import os

import pytest
from relay.persistence.skill_object_store import LocalSkillObjectStore


def test_local_skill_object_store_round_trips_content_by_digest(tmp_path):
    store = LocalSkillObjectStore(tmp_path / "objects")
    content = b"immutable skill content"
    digest = hashlib.sha256(content).hexdigest()

    store.put(digest, content)

    assert store.get(digest) == content
    assert store.exists(digest) is True
    assert store.path_for(digest) == tmp_path / "objects" / digest[:2] / digest[2:]


def test_local_skill_object_store_is_idempotent_and_rejects_digest_mismatch(tmp_path):
    store = LocalSkillObjectStore(tmp_path / "objects")
    content = b"same bytes"
    digest = hashlib.sha256(content).hexdigest()

    store.put(digest, content)
    store.put(digest, content)

    with pytest.raises(ValueError, match="digest"):
        store.put("0" * 64, content)
    assert store.get(digest) == content


@pytest.mark.parametrize(
    "digest",
    ["", "short", "../escape", "g" * 64, "A" * 64, "0" * 63],
)
def test_local_skill_object_store_rejects_unsafe_object_keys(tmp_path, digest):
    store = LocalSkillObjectStore(tmp_path / "objects")

    with pytest.raises(ValueError, match="digest"):
        store.get(digest)


def test_missing_local_skill_object_returns_none(tmp_path):
    store = LocalSkillObjectStore(tmp_path / "objects")

    assert store.get("0" * 64) is None
    assert store.exists("0" * 64) is False


def test_local_skill_object_store_refuses_symlinked_objects(tmp_path):
    store = LocalSkillObjectStore(tmp_path / "objects")
    content = b"outside"
    digest = hashlib.sha256(content).hexdigest()
    outside = tmp_path / "outside"
    outside.write_bytes(content)
    destination = store.path_for(digest)
    destination.parent.mkdir(parents=True)
    os.symlink(outside, destination)

    with pytest.raises(OSError, match="regular file"):
        store.get(digest)
    with pytest.raises(OSError, match="regular file"):
        store.put(digest, content)
