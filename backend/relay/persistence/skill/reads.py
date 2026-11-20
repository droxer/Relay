"""Skill catalog reads: skills, revisions, revision files, and blobs."""

from __future__ import annotations

from typing import Any

from sqlalchemy import and_, or_, select

from ..engine import store_transaction
from .rows import _revision_dict
from .state import SkillStoreState


class SkillReadRows(SkillStoreState):
    def get_skill(self, skill_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            exists = conn.scalar(
                select(self.skills.c.id).where(self.skills.c.id == skill_id)
            )
            return self._replay(conn, exists) if exists else None

    def list_skills(self, viewer_user_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            result = self._replay_matching(
                conn,
                and_(
                    self.skills.c.deleted_at.is_(None),
                    or_(
                        self.skills.c.visibility == "public",
                        self.skills.c.owner_user_id == viewer_user_id,
                    ),
                ),
            )
        return sorted(
            result, key=lambda item: (item["displayName"].casefold(), item["id"])
        )

    def get_revision(self, revision_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.revisions).where(self.revisions.c.id == revision_id)
                )
                .mappings()
                .first()
            )
        return _revision_dict(row) if row else None

    def list_revisions(
        self, skill_id: str, *, before: int | None = None, limit: int | None = None,
    ) -> list[dict[str, Any]]:
        statement = (
            select(self.revisions)
            .where(self.revisions.c.skill_id == skill_id)
            .order_by(self.revisions.c.revision.desc())
        )
        if before is not None:
            statement = statement.where(self.revisions.c.revision < before)
        if limit is not None:
            statement = statement.limit(limit)
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return [_revision_dict(row) for row in rows]

    def revision_files(self, revision_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(
                        self.files.c.path,
                        self.files.c.sha256,
                        self.files.c.bytes,
                    )
                    .join(self.blobs, self.blobs.c.sha256 == self.files.c.sha256)
                    .where(self.files.c.revision_id == revision_id)
                )
                .mappings()
                .all()
            )
        # Match _validate_files' ordering used to hash the published manifest.
        # Database collations can put agents/ before SKILL.md, invalidating the
        # digest even though every path and blob is unchanged.
        return sorted((dict(row) for row in rows), key=lambda item: item["path"])

    def blob(self, sha256: str) -> bytes | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.blobs.c.content).where(self.blobs.c.sha256 == sha256)
                )
                .mappings()
                .first()
            )
        if not row:
            return None
        # Read legacy database bytes during rolling upgrades, but every new
        # write goes through the filesystem object-store boundary.
        content = self.object_store.get(sha256)
        return content if content is not None else row["content"]
