"""Private uploads staged by owner, then retained with their Thread."""

from __future__ import annotations

import base64
import hashlib
import hmac
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any

from sqlalchemy import delete, insert, select, update
from loguru import logger

from ...core.ids import new_database_id
from ...core.thread_attachments import validate_image
from ..engine import after_store_commit, store_transaction
from ..sql import names_no_uuid_row
from ..tables.attachments import attachments
from .state import SessionStoreState


def _metadata(row: Any) -> dict[str, Any]:
    return {"id": row["id"], "mediaType": row["media_type"], "bytes": row["byte_size"], "sha256": row["sha256"]}


class SessionAttachmentRows(SessionStoreState):
    def create_attachment(self, owner: str, content: bytes, media_type: str) -> dict[str, Any]:
        validate_image(content, media_type)
        self.prune_staged_attachments()
        attachment_id = new_database_id()
        key = f"thread-attachments/{attachment_id}" if self.blob_store else None
        row = dict(
            id=attachment_id,
            owner_user_id=owner,
            media_type=media_type,
            byte_size=len(content),
            sha256=hashlib.sha256(content).hexdigest(),
            blob_key=key,
            content=None if key else base64.b64encode(content).decode(),
            created_at=datetime.now(UTC),
        )
        try:
            if key:
                self.blob_store.put(key, content, content_type=media_type)
            with store_transaction(self.engine) as conn:
                conn.execute(insert(attachments).values(**row))
        except Exception:  # noqa: BLE001 - compensate an uploaded object on any database failure
            if key:
                self._delete_attachment_blob(key)
            raise
        return _metadata(row)

    def attachment(self, attachment_id: str) -> dict[str, Any] | None:
        if names_no_uuid_row(self.engine, attachment_id):
            return None
        with store_transaction(self.engine) as conn:
            row = conn.execute(select(attachments).where(attachments.c.id == attachment_id)).mappings().first()
        return dict(row) if row else None

    def resolve_attachments(self, ids: tuple[str, ...], owner: str, session_id: str | None) -> list[dict[str, Any]]:
        result = []
        for attachment_id in ids:
            row = self.attachment(attachment_id)
            if not row or row["owner_user_id"] != owner or row["session_id"] not in (None, session_id):
                raise ValueError("Image attachment unavailable for this Thread.")
            result.append(_metadata(row))
        return result

    def bind_attachments(self, ids: list[str], session_id: str, owner: str) -> None:
        with store_transaction(self.engine) as conn:
            for attachment_id in ids:
                result = conn.execute(
                    update(attachments)
                    .where(
                        attachments.c.id == attachment_id,
                        attachments.c.owner_user_id == owner,
                        (attachments.c.session_id.is_(None) | (attachments.c.session_id == session_id)),
                    )
                    .values(session_id=session_id)
                )
                if result.rowcount != 1:
                    raise ValueError("Image attachment unavailable for this Thread.")

    def read_attachment(self, attachment_id: str) -> tuple[dict[str, Any], bytes] | None:
        row = self.attachment(attachment_id)
        if not row:
            return None
        content = (
            self.blob_store.get(row["blob_key"])
            if row["blob_key"] and self.blob_store
            else (base64.b64decode(row["content"]) if row["content"] else None)
        )
        if (
            content is None
            or len(content) != row["byte_size"]
            or not hmac.compare_digest(hashlib.sha256(content).hexdigest(), row["sha256"])
        ):
            return None
        return _metadata(row), content

    def prune_staged_attachments(self) -> None:
        cutoff = datetime.now(UTC) - timedelta(days=1)
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(attachments.c.id, attachments.c.blob_key)
                    .where(
                        attachments.c.session_id.is_(None),
                        attachments.c.created_at < cutoff,
                    )
                    .limit(100)
                    .with_for_update()
                )
                .mappings()
                .all()
            )
            for row in rows:
                conn.execute(delete(attachments).where(attachments.c.id == row["id"]))
                if row["blob_key"]:
                    after_store_commit(self.engine, partial(self._delete_attachment_blob, row["blob_key"]))

    def _delete_attachment_blob(self, key: str) -> None:
        if self.blob_store:
            try:
                self.blob_store.delete(key)
            except Exception as error:  # noqa: BLE001 - rows are gone; cleanup is best effort
                logger.warning("Could not remove attachment blob", blob_key=key, error=str(error))
