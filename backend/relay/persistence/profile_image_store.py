from __future__ import annotations

import base64
import binascii
import hashlib
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile

from sqlalchemy import Column, LargeBinary, Table, Text, delete, insert, select, update
from .store_common import metadata, shared_engine, create_all_tables, store_transaction
from .resource_lock import resource_transaction
from .store_common import safe_name


MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024
PROFILE_IMAGE_KINDS = frozenset({"agents", "teams"})

_DATA_URL = re.compile(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$")
_EXTENSIONS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
}


class ProfileImageError(ValueError):
    pass


class LocalProfileImageStore:
    """Stores user-selected profile images outside event-sourced snapshots."""

    def __init__(self, root_dir: str | Path):
        self.root = Path(root_dir) / "profile-images"

    def save(self, kind: str, entity_id: str, data_url: str) -> str:
        self._validate_kind(kind)
        content, content_type = decode_profile_image(data_url)
        extension = _EXTENSIONS[content_type]
        directory = self.root / kind
        directory.mkdir(parents=True, exist_ok=True)
        stem = safe_name(entity_id)
        extension = _EXTENSIONS[content_type]
        target = directory / f"{stem}.{extension}"
        with NamedTemporaryFile(
            dir=directory, prefix=f".{stem}-", delete=False
        ) as handle:
            handle.write(content)
            temporary = Path(handle.name)
        os.replace(temporary, target)
        for other_extension in _EXTENSIONS.values():
            sibling = directory / f"{stem}.{other_extension}"
            if sibling != target:
                sibling.unlink(missing_ok=True)

        version = hashlib.sha256(content).hexdigest()[:12]
        return f"/profile-images/{kind}/{entity_id}?v={version}"

    def read(self, kind: str, entity_id: str) -> tuple[bytes, str, str] | None:
        self._validate_kind(kind)
        stem = safe_name(entity_id)
        for content_type, extension in _EXTENSIONS.items():
            path = self.root / kind / f"{stem}.{extension}"
            if path.is_file():
                content = path.read_bytes()
                return content, content_type, hashlib.sha256(content).hexdigest()
        return None

    def delete(self, kind: str, entity_id: str) -> None:
        self._validate_kind(kind)
        stem = safe_name(entity_id)
        for extension in _EXTENSIONS.values():
            (self.root / kind / f"{stem}.{extension}").unlink(missing_ok=True)

    @staticmethod
    def _validate_kind(kind: str) -> None:
        if kind not in PROFILE_IMAGE_KINDS:
            raise ProfileImageError("profile_image_kind")


def _has_valid_signature(content_type: str, content: bytes) -> bool:
    if content_type == "image/png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/jpeg":
        return content.startswith(b"\xff\xd8\xff")
    if content_type == "image/webp":
        return (
            len(content) >= 12
            and content.startswith(b"RIFF")
            and content[8:12] == b"WEBP"
        )
    return False


def decode_profile_image(data_url: str) -> tuple[bytes, str]:
    match = _DATA_URL.fullmatch(data_url.strip()) if isinstance(data_url, str) else None
    if not match:
        raise ProfileImageError("profile_image_type")
    content_type, encoded = match.groups()
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ProfileImageError("profile_image_invalid") from error
    if not content:
        raise ProfileImageError("profile_image_invalid")
    if len(content) > MAX_PROFILE_IMAGE_BYTES:
        raise ProfileImageError("profile_image_too_large")
    if not _has_valid_signature(content_type, content):
        raise ProfileImageError("profile_image_invalid")

    return content, content_type


class DatabaseProfileImageStore:
    """Small, size-limited images shared by all backend replicas."""

    images = Table(
        "profile_images",
        metadata,
        Column("kind", Text, primary_key=True),
        Column("entity_id", Text, primary_key=True),
        Column("content", LargeBinary, nullable=False),
        Column("content_type", Text, nullable=False),
        Column("etag", Text, nullable=False),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def save(self, kind: str, entity_id: str, data_url: str) -> str:
        LocalProfileImageStore._validate_kind(kind)
        content, content_type = decode_profile_image(data_url)
        etag = hashlib.sha256(content).hexdigest()
        with resource_transaction(
            self.engine, f"profile-image:{kind}:{entity_id}"
        ) as conn:
            values = dict(content=content, content_type=content_type, etag=etag)
            changed = conn.execute(
                update(self.images)
                .where(self.images.c.kind == kind, self.images.c.entity_id == entity_id)
                .values(**values)
            ).rowcount
            if not changed:
                conn.execute(
                    insert(self.images).values(kind=kind, entity_id=entity_id, **values)
                )
        return f"/profile-images/{kind}/{entity_id}?v={etag[:12]}"

    def read(self, kind: str, entity_id: str) -> tuple[bytes, str, str] | None:
        LocalProfileImageStore._validate_kind(kind)
        with store_transaction(self.engine) as conn:
            row = conn.execute(
                select(
                    self.images.c.content,
                    self.images.c.content_type,
                    self.images.c.etag,
                ).where(
                    self.images.c.kind == kind, self.images.c.entity_id == entity_id
                )
            ).first()
        return tuple(row) if row else None

    def delete(self, kind: str, entity_id: str) -> None:
        LocalProfileImageStore._validate_kind(kind)
        with resource_transaction(
            self.engine, f"profile-image:{kind}:{entity_id}"
        ) as conn:
            conn.execute(
                delete(self.images).where(
                    self.images.c.kind == kind, self.images.c.entity_id == entity_id
                )
            )
