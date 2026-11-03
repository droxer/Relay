from __future__ import annotations

from datetime import UTC, datetime, timedelta
import importlib.util
from pathlib import Path
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text, update
from relay.persistence.blob.store import R2BlobStore
from relay.persistence.session.store import DatabaseSessionStore
from relay.persistence.tables.attachments import attachments
from store_fixtures import sqlite_url
from test_blob_store import FakeS3

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + b"\x00" * 17


@pytest.mark.parametrize("r2", [False, True])
def test_image_round_trip_and_thread_deletion(tmp_path, r2):
    s3 = FakeS3()
    store = DatabaseSessionStore(
        sqlite_url(tmp_path), create_schema=True, blob_store=R2BlobStore(s3, "images") if r2 else None
    )
    image = store.create_attachment("owner", PNG, "image/png")
    row = store.attachment(image["id"])
    assert (row["content"] is None) is r2
    assert store.read_attachment(image["id"]) == (image, PNG)
    session = store.create_session({"workspacePath": "/workspace", "taskGoal": "Describe", "ownerUserId": "owner"})
    store.bind_attachments([image["id"]], session["id"], "owner")
    with pytest.raises(ValueError):
        store.resolve_attachments((image["id"],), "owner", "another-thread")
    store.delete_session(session["id"])
    assert store.read_attachment(image["id"]) is None
    assert not s3.objects


def test_missing_or_corrupt_r2_image_is_unavailable(tmp_path):
    s3 = FakeS3()
    store = DatabaseSessionStore(sqlite_url(tmp_path), create_schema=True, blob_store=R2BlobStore(s3, "images"))
    image = store.create_attachment("owner", PNG, "image/png")
    key = store.attachment(image["id"])["blob_key"]
    s3.objects[("images", key)]["body"] = b"corrupt"
    assert store.read_attachment(image["id"]) is None
    del s3.objects[("images", key)]
    assert store.read_attachment(image["id"]) is None


def test_abandoned_uploads_expire_but_bound_images_remain(tmp_path):
    s3 = FakeS3()
    store = DatabaseSessionStore(sqlite_url(tmp_path), create_schema=True, blob_store=R2BlobStore(s3, "images"))
    staged = store.create_attachment("owner", PNG, "image/png")
    bound = store.create_attachment("owner", PNG, "image/png")
    session = store.create_session({"workspacePath": "/workspace", "taskGoal": "Describe"})
    store.bind_attachments([bound["id"]], session["id"], "owner")
    with store.engine.begin() as conn:
        conn.execute(update(attachments).values(created_at=datetime.now(UTC) - timedelta(days=2)))
    store.prune_staged_attachments()
    assert store.attachment(staged["id"]) is None
    assert store.read_attachment(bound["id"]) == (bound, PNG)
    assert len(s3.objects) == 1


def test_binding_a_batch_is_atomic(tmp_path):
    store = DatabaseSessionStore(sqlite_url(tmp_path), create_schema=True)
    image = store.create_attachment("owner", PNG, "image/png")
    session = store.create_session({"workspacePath": "/workspace", "taskGoal": "Describe"})
    with pytest.raises(ValueError):
        store.bind_attachments([image["id"], str(uuid4())], session["id"], "owner")
    assert store.attachment(image["id"])["session_id"] is None


def test_upload_that_fails_after_storing_bytes_is_compensated(tmp_path):
    class FailingS3(FakeS3):
        def put_object(self, **kwargs):
            super().put_object(**kwargs)
            raise RuntimeError("ambiguous upload failure")

    s3 = FailingS3()
    store = DatabaseSessionStore(sqlite_url(tmp_path), create_schema=True, blob_store=R2BlobStore(s3, "images"))
    with pytest.raises(RuntimeError, match="ambiguous"):
        store.create_attachment("owner", PNG, "image/png")
    assert not s3.objects


def test_attachment_migration_upgrades_and_downgrades():
    path = Path(__file__).parents[2] / "migrations/versions/20261103_0109_thread_attachments.py"
    spec = importlib.util.spec_from_file_location("thread_attachments_migration", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with create_engine("sqlite:///:memory:").begin() as connection:
        connection.execute(text("CREATE TABLE sessions (id TEXT PRIMARY KEY)"))
        module.op = Operations(MigrationContext.configure(connection))
        module.upgrade()
        columns = {column["name"] for column in inspect(connection).get_columns("thread_attachments")}
        assert {
            "id",
            "owner_user_id",
            "session_id",
            "media_type",
            "byte_size",
            "sha256",
            "blob_key",
            "content",
            "created_at",
        } == columns
        assert len(inspect(connection).get_indexes("thread_attachments")) == 2
        module.downgrade()
        assert "thread_attachments" not in inspect(connection).get_table_names()
