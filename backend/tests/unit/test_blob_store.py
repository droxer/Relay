from __future__ import annotations

import io
from typing import Any

import pytest
from relay.persistence import blob_store as blob_store_module
from relay.persistence.blob_store import R2BlobStore, blob_store_from_env

R2_ENV = {
    "RELAY_BLOB_STORE": "r2",
    "RELAY_R2_ACCOUNT_ID": "acct123",
    "RELAY_R2_ACCESS_KEY_ID": "key-id",
    "RELAY_R2_SECRET_ACCESS_KEY": "secret",
    "RELAY_R2_BUCKET": "relay-artifacts",
}


class _NotFound(Exception):
    def __init__(self) -> None:
        super().__init__("not found")
        self.response = {"Error": {"Code": "NoSuchKey"}}


class FakeS3:
    """The S3 calls R2BlobStore makes, against a dict."""

    def __init__(self, page_size: int = 1000) -> None:
        self.objects: dict[tuple[str, str], dict[str, Any]] = {}
        self.page_size = page_size
        self.delete_batches: list[int] = []

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, **extra: Any) -> None:
        self.objects[(Bucket, Key)] = {"body": Body, **extra}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise _NotFound()
        return {"Body": io.BytesIO(self.objects[(Bucket, Key)]["body"])}

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if (Bucket, Key) not in self.objects:
            raise _NotFound()
        return {}

    def delete_object(self, *, Bucket: str, Key: str) -> None:
        self.objects.pop((Bucket, Key), None)

    def list_objects_v2(self, *, Bucket: str, Prefix: str, **kwargs: Any) -> dict[str, Any]:
        keys = sorted(k for b, k in self.objects if b == Bucket and k.startswith(Prefix))
        start = int(kwargs.get("ContinuationToken", "0"))
        page = keys[start : start + self.page_size]
        more = start + self.page_size < len(keys)
        response: dict[str, Any] = {"Contents": [{"Key": k} for k in page], "IsTruncated": more}
        if more:
            response["NextContinuationToken"] = str(start + self.page_size)
        return response

    def delete_objects(self, *, Bucket: str, Delete: dict[str, Any]) -> dict[str, Any]:
        self.delete_batches.append(len(Delete["Objects"]))
        for item in Delete["Objects"]:
            self.objects.pop((Bucket, item["Key"]), None)
        return {}


@pytest.fixture(autouse=True)
def clear_blob_env(monkeypatch) -> None:
    for name in (*R2_ENV, "RELAY_R2_ENDPOINT"):
        monkeypatch.delenv(name, raising=False)


class TestR2BlobStore:
    def test_round_trip(self) -> None:
        s3 = FakeS3()
        store = R2BlobStore(s3, "bucket")
        store.put("a/b", b"\x00bytes", content_type="application/pdf")
        assert store.get("a/b") == b"\x00bytes"
        assert s3.objects[("bucket", "a/b")]["ContentType"] == "application/pdf"

    def test_missing_key_reads_as_none(self) -> None:
        assert R2BlobStore(FakeS3(), "bucket").get("nope") is None

    def test_other_errors_propagate(self) -> None:
        class Broken(FakeS3):
            def get_object(self, **kwargs: Any) -> dict[str, Any]:
                raise RuntimeError("network down")

        with pytest.raises(RuntimeError, match="network down"):
            R2BlobStore(Broken(), "bucket").get("a")

    def test_exists(self) -> None:
        store = R2BlobStore(FakeS3(), "bucket")
        assert store.exists("a") is False
        store.put("a", b"1", content_type=None)
        assert store.exists("a") is True

    def test_delete(self) -> None:
        store = R2BlobStore(FakeS3(), "bucket")
        store.put("a", b"1", content_type=None)
        store.delete("a")
        assert store.get("a") is None

    def test_delete_prefix_pages_and_spares_siblings(self) -> None:
        s3 = FakeS3(page_size=2)
        store = R2BlobStore(s3, "bucket")
        for index in range(5):
            store.put(f"session-artifacts/s1/{index}", b"x", content_type=None)
        store.put("session-artifacts/s10/keep", b"x", content_type=None)

        store.delete_prefix("session-artifacts/s1/")

        assert [key for _bucket, key in s3.objects] == ["session-artifacts/s10/keep"]
        assert sum(s3.delete_batches) == 5

    def test_empty_prefix_is_refused(self) -> None:
        with pytest.raises(ValueError):
            R2BlobStore(FakeS3(), "bucket").delete_prefix("")


class TestBlobStoreFromEnv:
    def test_database_is_the_default(self) -> None:
        assert blob_store_from_env() is None

    def test_database_can_be_named(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_BLOB_STORE", "database")
        assert blob_store_from_env() is None

    def test_unknown_mode_is_rejected(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_BLOB_STORE", "s4")
        with pytest.raises(RuntimeError, match="RELAY_BLOB_STORE"):
            blob_store_from_env()

    def test_r2_reports_every_missing_setting(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_BLOB_STORE", "r2")
        with pytest.raises(RuntimeError) as error:
            blob_store_from_env()
        for name in ("RELAY_R2_ACCOUNT_ID", "RELAY_R2_ACCESS_KEY_ID", "RELAY_R2_SECRET_ACCESS_KEY", "RELAY_R2_BUCKET"):
            assert name in str(error.value)

    def test_r2_builds_a_client_for_the_account_endpoint(self, monkeypatch) -> None:
        for name, value in R2_ENV.items():
            monkeypatch.setenv(name, value)
        calls: list[dict[str, str]] = []
        monkeypatch.setattr(
            blob_store_module, "_s3_client", lambda **kwargs: calls.append(kwargs) or FakeS3()
        )

        store = blob_store_from_env()

        assert isinstance(store, R2BlobStore)
        assert store.bucket == "relay-artifacts"
        assert calls == [{
            "endpoint_url": "https://acct123.r2.cloudflarestorage.com",
            "access_key_id": "key-id",
            "secret_access_key": "secret",
        }]

    def test_endpoint_override_must_be_https(self, monkeypatch) -> None:
        for name, value in R2_ENV.items():
            monkeypatch.setenv(name, value)
        monkeypatch.setattr(blob_store_module, "_s3_client", lambda **kwargs: FakeS3())
        monkeypatch.setenv("RELAY_R2_ENDPOINT", "http://r2.example.com")
        with pytest.raises(RuntimeError, match="RELAY_R2_ENDPOINT"):
            blob_store_from_env()
        monkeypatch.setenv("RELAY_R2_ENDPOINT", "https://acct123.eu.r2.cloudflarestorage.com/")
        assert blob_store_from_env() is not None


def test_backend_refuses_to_start_with_incomplete_r2_settings(monkeypatch, tmp_path) -> None:
    from relay.app import create_app

    monkeypatch.setenv("RELAY_BLOB_STORE", "r2")
    with pytest.raises(RuntimeError, match="RELAY_R2_BUCKET"):
        create_app(tmp_path / "data")
