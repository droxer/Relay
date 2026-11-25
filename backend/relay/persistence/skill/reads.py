"""Skill catalog reads: skills, revisions, revision files, and blobs."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Collection
from itertools import batched
from typing import Any

from sqlalchemy import and_, or_, select

from ..engine import store_transaction
from ..sql import names_no_uuid_row
from .rows import _revision_dict
from .state import SkillStoreState


class SkillReadRows(SkillStoreState):
    def get_skill(self, skill_id: str) -> dict[str, Any] | None:
        if names_no_uuid_row(self.engine, skill_id):
            return None
        skills = self.skills
        with store_transaction(self.engine) as conn:
            row = conn.execute(select(skills.c.id, skills.c.snapshot).where(skills.c.id == skill_id)).first()
            return self._read_projection(conn, row.id, row.snapshot) if row is not None else None

    def get_skills_by_ids(self, skill_ids: Collection[str]) -> dict[str, dict[str, Any]]:
        ids = sorted(key for key in set(skill_ids) if not names_no_uuid_row(self.engine, key))
        skills = self.skills
        results: dict[str, dict[str, Any]] = {}
        if not ids:
            return results
        with store_transaction(self.engine) as conn:
            for batch in batched(ids, 500, strict=False):
                selected = conn.execute(select(skills.c.id, skills.c.snapshot).where(skills.c.id.in_(batch)))
                results.update(self._read_projections(conn, selected))
        return results

    def list_skills(self, viewer_user_id: str) -> list[dict[str, Any]]:
        skills = self.skills
        statement = select(skills.c.id, skills.c.snapshot).where(and_(
            skills.c.deleted_at.is_(None),
            or_(skills.c.visibility == "public", skills.c.owner_user_id == viewer_user_id),
        ))
        with store_transaction(self.engine) as conn:
            result = self._read_projections(conn, conn.execute(statement)).values()
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

    def get_revisions_by_ids(self, revision_ids: Collection[str]) -> dict[str, dict[str, Any]]:
        ids = sorted(key for key in set(revision_ids) if not names_no_uuid_row(self.engine, key))
        if not ids:
            return {}
        revisions = self.revisions
        with store_transaction(self.engine) as conn:
            return {
                str(row["id"]): _revision_dict(row)
                for batch in batched(ids, 500, strict=False)
                for row in conn.execute(select(revisions).where(revisions.c.id.in_(batch))).mappings()
            }

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
        return self.revision_files_by_ids({revision_id}).get(revision_id, [])

    def revision_files_by_ids(self, revision_ids: Collection[str]) -> dict[str, list[dict[str, Any]]]:
        ids = sorted(key for key in set(revision_ids) if not names_no_uuid_row(self.engine, key))
        if not ids:
            return {}
        files = self.files
        statement = select(files.c.revision_id, files.c.path, files.c.sha256, files.c.bytes).join(
            self.blobs, self.blobs.c.sha256 == files.c.sha256,
        )
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        with store_transaction(self.engine) as conn:
            for batch in batched(ids, 500, strict=False):
                for key, path, sha256, size in conn.execute(statement.where(files.c.revision_id.in_(batch))):
                    grouped[str(key)].append({"path": path, "sha256": sha256, "bytes": size})
        # Match _validate_files' ordering used to hash the published manifest.
        # Database collations can put agents/ before SKILL.md, invalidating the
        # digest even though every path and blob is unchanged.
        return {key: sorted(items, key=lambda item: item["path"]) for key, items in grouped.items()}

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
