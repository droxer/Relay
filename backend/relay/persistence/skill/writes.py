"""Skill catalog writes: create, revise, promote, patch, and delete."""

from __future__ import annotations

import hashlib
from typing import Any

from sqlalchemy import insert, select, text, update
from sqlalchemy.exc import IntegrityError

from ...core.ids import new_database_id, now_iso
from ..db_time import parse_db_time
from ..engine import store_transaction
from .rows import _skill_row
from ...skills.rules import (
    SkillValidationError,
    _display_name,
    _identity_part,
    _manifest_sha256,
    _namespace,
    _required_text,
    _skill_name,
    _validate_files,
)
from .state import SkillStoreState, _SkillWriteConflict


class SkillWriteRows(SkillStoreState):
    def create_skill(
        self, owner_user_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        files, manifest = _validate_files(payload.get("files"))
        name = _skill_name(payload.get("name"))
        namespace = _namespace(payload.get("namespace"))
        if manifest["name"] != name:
            raise SkillValidationError("skill-name-mismatch")
        visibility = payload.get("visibility", "private")
        source = payload.get("source", "authored")
        if visibility not in ("private", "org"):
            raise SkillValidationError("invalid-visibility")
        if source not in ("authored", "upload", "git"):
            raise SkillValidationError("invalid-source")
        with self._write_lock:
            try:
                with store_transaction(self.engine) as conn:
                    if self.engine.dialect.name == "postgresql":
                        conn.execute(
                            text(
                                "SELECT pg_advisory_xact_lock(hashtext('relay.skill.slug-allocation'))"
                            )
                        )
                    slug = self._allocate_slug(
                        conn, namespace, name, payload.get("ownerHandle")
                    )
                    timestamp = now_iso()
                    skill = {
                        "id": new_database_id(),
                        "ownerUserId": owner_user_id,
                        "namespace": namespace,
                        "name": name,
                        "slug": slug,
                        "displayName": _display_name(payload.get("displayName"), name),
                        "description": manifest["description"],
                        "visibility": visibility,
                        "source": source,
                        "sourceRef": payload.get("sourceRef"),
                        "currentRevisionId": None,
                        "stableRevisionId": None,
                        "createdAt": timestamp,
                        "updatedAt": timestamp,
                        "deletedAt": None,
                    }
                    conn.execute(
                        insert(self.skills).values(**_skill_row(skill, event_version=0))
                    )
                    self._append_event(
                        conn, skill["id"], 0, "skill.created", {"skill": skill}
                    )
                    revision = self._insert_revision(
                        conn,
                        skill["id"],
                        1,
                        owner_user_id,
                        files,
                        payload.get("note"),
                    )
                    skill = {
                        **skill,
                        "currentRevisionId": revision["id"],
                        "stableRevisionId": revision["id"],
                    }
                    conn.execute(
                        update(self.skills)
                        .where(self.skills.c.id == skill["id"])
                        .values(**_skill_row(skill, event_version=2))
                    )
                    self._append_event(
                        conn,
                        skill["id"],
                        1,
                        "skill.revision.added",
                        {
                            "revision": revision,
                            "currentRevisionId": revision["id"],
                            "stableRevisionId": revision["id"],
                        },
                    )
                return skill
            except IntegrityError as error:
                raise self._integrity_error(error) from error

    def add_revision(
        self,
        skill_id: str,
        created_by_user_id: str,
        files: list[dict[str, Any]],
        note: str | None = None,
    ) -> dict[str, Any]:
        normalized, manifest = _validate_files(files)
        with self._write_lock:
            try:
                with store_transaction(self.engine) as conn:
                    row = (
                        conn.execute(
                            select(self.skills.c.id, self.skills.c.event_version)
                            .where(self.skills.c.id == skill_id)
                            .with_for_update()
                        )
                        .mappings()
                        .first()
                    )
                    if not row:
                        raise KeyError(skill_id)
                    current = self._replay(conn, row["id"])
                    if current.get("deletedAt"):
                        raise SkillValidationError("skill-deleted")
                    if manifest["name"] != current["name"]:
                        raise SkillValidationError("skill-name-mismatch")
                    number = (
                        int(
                            conn.scalar(
                                select(self.revisions.c.revision)
                                .where(self.revisions.c.skill_id == row["id"])
                                .order_by(self.revisions.c.revision.desc())
                                .limit(1)
                            )
                            or 0
                        )
                        + 1
                    )
                    revision = self._insert_revision(
                        conn,
                        row["id"],
                        number,
                        created_by_user_id,
                        normalized,
                        note,
                    )
                    timestamp = now_iso()
                    updated = {
                        **current,
                        "currentRevisionId": revision["id"],
                        "description": manifest["description"],
                        "updatedAt": timestamp,
                    }
                    sequence = int(row["event_version"])
                    claimed = conn.execute(
                        update(self.skills)
                        .where(
                            self.skills.c.id == row["id"],
                            self.skills.c.event_version == sequence,
                        )
                        .values(**_skill_row(updated, event_version=sequence + 1))
                    )
                    if claimed.rowcount != 1:
                        raise _SkillWriteConflict(skill_id)
                    self._append_event(
                        conn,
                        row["id"],
                        sequence,
                        "skill.revision.added",
                        {
                            "revision": revision,
                            "currentRevisionId": revision["id"],
                            "description": manifest["description"],
                            "updatedAt": timestamp,
                        },
                    )
                return updated
            except IntegrityError as error:
                raise self._integrity_error(error) from error

    def promote_revision(
        self, skill_id: str, revision_id: str
    ) -> dict[str, Any]:
        with self._write_lock, store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.skills.c.id, self.skills.c.event_version)
                    .where(self.skills.c.id == skill_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(skill_id)
            current = self._replay(conn, row["id"])
            if current.get("deletedAt"):
                raise SkillValidationError("skill-deleted")
            revision = (
                conn.execute(
                    select(self.revisions.c.id).where(
                        self.revisions.c.id == revision_id,
                        self.revisions.c.skill_id == skill_id,
                    )
                )
                .first()
            )
            if not revision:
                raise SkillValidationError("revision-not-found")
            timestamp = now_iso()
            updated = {
                **current,
                "stableRevisionId": revision_id,
                "updatedAt": timestamp,
            }
            sequence = int(row["event_version"])
            claimed = conn.execute(
                update(self.skills)
                .where(
                    self.skills.c.id == row["id"],
                    self.skills.c.event_version == sequence,
                )
                .values(**_skill_row(updated, event_version=sequence + 1))
            )
            if claimed.rowcount != 1:
                raise _SkillWriteConflict(skill_id)
            self._append_event(
                conn,
                row["id"],
                sequence,
                "skill.revision.promoted",
                {"stableRevisionId": revision_id, "updatedAt": timestamp},
            )
            return updated

    def update_skill(self, skill_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        allowed = {"displayName", "description", "visibility"}
        if set(patch) - allowed or not patch:
            raise SkillValidationError("skill-patch-unsupported")
        normalized = dict(patch)
        if "visibility" in normalized and normalized["visibility"] not in (
            "private",
            "org",
        ):
            raise SkillValidationError("invalid-visibility")
        if "displayName" in normalized:
            normalized["displayName"] = _required_text(
                normalized["displayName"], "display-name-required"
            )
        if "description" in normalized:
            normalized["description"] = _required_text(
                normalized["description"], "skill-description-required"
            )
        return self._mutate(skill_id, "skill.updated", normalized)

    def delete_skill(self, skill_id: str) -> dict[str, Any]:
        return self._mutate(skill_id, "skill.deleted", {}, deleting=True)

    def _mutate(
        self,
        skill_id: str,
        event_type: str,
        patch: dict[str, Any],
        *,
        deleting: bool = False,
    ) -> dict[str, Any]:
        with self._write_lock:
            with store_transaction(self.engine) as conn:
                row = (
                    conn.execute(
                        select(self.skills.c.id, self.skills.c.event_version)
                        .where(self.skills.c.id == skill_id)
                        .with_for_update()
                    )
                    .mappings()
                    .first()
                )
                if not row:
                    raise KeyError(skill_id)
                current = self._replay(conn, row["id"])
                if current.get("deletedAt"):
                    raise SkillValidationError("skill-deleted")
                timestamp = now_iso()
                updated = {**current, **patch, "updatedAt": timestamp}
                if deleting:
                    updated["deletedAt"] = timestamp
                sequence = int(row["event_version"])
                conn.execute(
                    update(self.skills)
                    .where(
                        self.skills.c.id == row["id"],
                        self.skills.c.event_version == sequence,
                    )
                    .values(**_skill_row(updated, event_version=sequence + 1))
                )
                self._append_event(
                    conn,
                    row["id"],
                    sequence,
                    event_type,
                    {
                        "patch": patch,
                        "updatedAt": timestamp,
                        "deletedAt": updated.get("deletedAt"),
                    },
                )
            return updated

    def _insert_revision(
        self,
        conn: Any,
        skill_id: str,
        number: int,
        user_id: str,
        files: list[dict[str, Any]],
        note: str | None,
    ) -> dict[str, Any]:
        timestamp = now_iso()
        revision = {
            "id": new_database_id(),
            "skillId": str(skill_id),
            "revision": number,
            "manifestSha256": _manifest_sha256(files),
            "bytes": sum(len(item["content"]) for item in files),
            "createdAt": timestamp,
            "createdByUserId": user_id,
            "note": note,
        }
        conn.execute(
            insert(self.revisions).values(
                id=revision["id"],
                skill_id=skill_id,
                revision=number,
                manifest_sha256=revision["manifestSha256"],
                bytes=revision["bytes"],
                created_at=parse_db_time(timestamp),
                created_by_user_id=user_id,
                note=note,
            )
        )
        for item in files:
            digest = hashlib.sha256(item["content"]).hexdigest()
            self.object_store.put(digest, item["content"])
            try:
                with conn.begin_nested():
                    conn.execute(
                        insert(self.blobs).values(
                            sha256=digest,
                            content=None,
                            bytes=len(item["content"]),
                        )
                    )
            except IntegrityError:
                pass
            conn.execute(
                insert(self.files).values(
                    id=new_database_id(),
                    revision_id=revision["id"],
                    path=item["path"],
                    sha256=digest,
                    bytes=len(item["content"]),
                )
            )
        return revision

    def _allocate_slug(
        self, conn: Any, namespace: str | None, name: str, owner_handle: Any
    ) -> str:
        base = f"{namespace}/{name}" if namespace else name
        if len(base) > 512:
            raise SkillValidationError("invalid-namespace", "Skill slug exceeds 512 characters")
        handle = (
            _identity_part(owner_handle, "invalid-owner-handle")
            if owner_handle
            else None
        )
        # The Agent Skills spec requires SKILL.md's name to match its parent
        # directory. Resolve catalog collisions by adding parent namespaces,
        # never by changing the leaf directory that carries the skill.
        candidates = [base]
        if handle:
            candidates.append(f"{handle}/{base}")
        candidates.extend(f"skill-{i}/{base}" for i in range(2, 1000))
        live = set(
            conn.scalars(
                select(self.skills.c.slug).where(self.skills.c.deleted_at.is_(None))
            ).all()
        )
        for candidate in candidates:
            if len(candidate) > 512:
                continue
            if not any(
                candidate == slug
                or candidate.startswith(slug + "/")
                or slug.startswith(candidate + "/")
                for slug in live
            ):
                return candidate
        raise SkillValidationError("slug-unavailable")

    @staticmethod
    def _integrity_error(error: IntegrityError) -> SkillValidationError:
        message = str(error.orig).lower()
        if "owner_name" in message or "namespace_key" in message:
            return SkillValidationError("skill-name-taken")
        if "slug" in message:
            return SkillValidationError("slug-unavailable")
        return SkillValidationError("skill-conflict")
