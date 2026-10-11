"""Object storage for file bytes that do not belong in Postgres.

The database stays the source of truth for *which* files exist; a blob store
only holds their bytes, addressed by a key the database records. Without one
configured (``RELAY_BLOB_STORE`` unset or ``database``) every caller keeps its
bytes inline in the database exactly as before, so self-hosted installs are
unaffected.

``r2`` targets Cloudflare R2 through its S3-compatible API. ``boto3`` ships in
the backend's ``r2`` extra and is imported only when R2 is selected.
"""

from __future__ import annotations

import os
from typing import Any, Protocol
from urllib.parse import urlsplit

_DELETE_BATCH = 1000  # S3 DeleteObjects limit.
_NOT_FOUND_CODES = frozenset({"NoSuchKey", "404", "NotFound"})
_R2_SETTINGS = (
    "RELAY_R2_ACCOUNT_ID",
    "RELAY_R2_ACCESS_KEY_ID",
    "RELAY_R2_SECRET_ACCESS_KEY",
    "RELAY_R2_BUCKET",
)


class BlobStore(Protocol):
    def put(self, key: str, data: bytes, *, content_type: str | None) -> None: ...

    def get(self, key: str) -> bytes | None: ...

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None: ...

    def delete_prefix(self, prefix: str) -> None: ...


class R2BlobStore:
    """A bucket on R2 (or any S3-compatible endpoint), through a boto3 client."""

    def __init__(self, client: Any, bucket: str):
        self.client = client
        self.bucket = bucket

    def put(self, key: str, data: bytes, *, content_type: str | None) -> None:
        extra = {"ContentType": content_type} if content_type else {}
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, **extra)

    def get(self, key: str) -> bytes | None:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except Exception as error:  # botocore's ClientError, without importing it
            if _error_code(error) in _NOT_FOUND_CODES:
                return None
            raise
        return response["Body"].read()

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            if _error_code(error) in _NOT_FOUND_CODES:
                return False
            raise
        return True

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def delete_prefix(self, prefix: str) -> None:
        if not prefix:
            raise ValueError("Refusing to delete an empty prefix: it is the whole bucket.")
        keys: list[str] = []
        token: str | None = None
        while True:
            page = self.client.list_objects_v2(
                Bucket=self.bucket, Prefix=prefix, **({"ContinuationToken": token} if token else {})
            )
            keys.extend(item["Key"] for item in page.get("Contents", []))
            if not page.get("IsTruncated"):
                break
            token = page["NextContinuationToken"]
        for start in range(0, len(keys), _DELETE_BATCH):
            batch = keys[start : start + _DELETE_BATCH]
            self.client.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True},
            )


def _error_code(error: Exception) -> str | None:
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return None
    return str(response.get("Error", {}).get("Code") or "") or None


def _s3_client(*, endpoint_url: str, access_key_id: str, secret_access_key: str) -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise RuntimeError(
            "RELAY_BLOB_STORE=r2 needs boto3: install the backend with its 'r2' extra."
        ) from error
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=Config(
            retries={"max_attempts": 3, "mode": "standard"},
            # R2 does not implement every default checksum newer boto3 sends.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


def _r2_endpoint(account_id: str) -> str:
    override = os.environ.get("RELAY_R2_ENDPOINT", "").strip()
    if not override:
        return f"https://{account_id}.r2.cloudflarestorage.com"
    parsed = urlsplit(override)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/"):
        raise RuntimeError("RELAY_R2_ENDPOINT must be an HTTPS origin, e.g. https://<account>.eu.r2.cloudflarestorage.com.")
    return override.rstrip("/")


def blob_store_from_env() -> BlobStore | None:
    mode = os.environ.get("RELAY_BLOB_STORE", "").strip().lower()
    if mode in ("", "database"):
        return None
    if mode != "r2":
        raise RuntimeError("RELAY_BLOB_STORE must be one of: database, r2.")
    values = {name: os.environ.get(name, "").strip() for name in _R2_SETTINGS}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise RuntimeError(f"RELAY_BLOB_STORE=r2 requires {', '.join(missing)}.")
    client = _s3_client(
        endpoint_url=_r2_endpoint(values["RELAY_R2_ACCOUNT_ID"]),
        access_key_id=values["RELAY_R2_ACCESS_KEY_ID"],
        secret_access_key=values["RELAY_R2_SECRET_ACCESS_KEY"],
    )
    return R2BlobStore(client, values["RELAY_R2_BUCKET"])
