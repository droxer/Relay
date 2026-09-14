from __future__ import annotations

import hashlib
import re
from threading import RLock
from typing import Any

import yaml
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Table,
    Text,
    UniqueConstraint,
    delete,
    insert,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError

from ..core.ids import new_database_id, now_iso
from ..security.auth import DatabaseUserAuthStore
from .store_common import (
    _format_iso,
    _parse_iso,
    create_all_tables,
    database_id_column,
    entity_uuid_type,
    json_type,
    shared_engine,
    store_transaction,
)
from .store_common import metadata as shared_metadata
from .skill_object_store import SkillObjectStore

MAX_FILES = 300
MAX_FILE_BYTES = 1_048_576
MAX_REVISION_BYTES = 4_194_304
_PART = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
_PATH_PART = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$")
_FRONTMATTER = re.compile(
    rb"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL
)


class SkillValidationError(ValueError):
    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


class _SkillWriteConflict(RuntimeError):
    pass


class DatabaseSkillStore:
    """Event-authoritative catalog with immutable bundle revisions."""

    metadata = shared_metadata
    employees = DatabaseUserAuthStore.employees
    skills = Table(
        "skills",
        metadata,
        database_id_column(),
        Column(
            "owner_employee_id",
            entity_uuid_type(),
            ForeignKey("employees.id", ondelete="RESTRICT", name="fk_skills_owner"),
            nullable=False,
        ),
        Column("namespace_key", Text, nullable=False),
        Column("name_key", Text, nullable=False),
        Column("slug", Text, nullable=False),
        Column("visibility", Text, nullable=False),
        Column("snapshot", json_type(), nullable=False),
        Column("event_version", BigInteger, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("deleted_at", DateTime(timezone=True), nullable=True),
        CheckConstraint(
            "visibility IN ('private', 'org')", name="ck_skills_visibility"
        ),
        Index("ix_skills_owner_updated", "owner_employee_id", "updated_at"),
        Index(
            "uq_skills_live_slug",
            "slug",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
        Index(
            "uq_skills_live_owner_name",
            "owner_employee_id",
            "namespace_key",
            "name_key",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )
    revisions = Table(
        "skill_revisions",
        metadata,
        database_id_column(),
        Column(
            "skill_id",
            entity_uuid_type(),
            ForeignKey("skills.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("revision", Integer, nullable=False),
        Column("manifest_sha256", Text, nullable=False),
        Column("bytes", BigInteger, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column(
            "created_by_employee_id",
            entity_uuid_type(),
            ForeignKey("employees.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        Column("note", Text, nullable=True),
        CheckConstraint("revision > 0", name="ck_skill_revisions_positive"),
        CheckConstraint(
            "bytes >= 0 AND bytes <= 4194304", name="ck_skill_revisions_bytes"
        ),
        UniqueConstraint("skill_id", "revision", name="uq_skill_revisions_number"),
        Index("ix_skill_revisions_skill", "skill_id", "revision"),
    )
    blobs = Table(
        "skill_blobs",
        metadata,
        Column("sha256", Text, primary_key=True),
        # Bundle bytes live in SkillObjectStore. This nullable compatibility
        # column lets upgraded databases retain blobs written by older builds.
        Column("content", LargeBinary, nullable=True),
        Column("bytes", BigInteger, nullable=False),
        CheckConstraint("bytes >= 0 AND bytes <= 1048576", name="ck_skill_blobs_bytes"),
    )
    files = Table(
        "skill_files",
        metadata,
        database_id_column(),
        Column(
            "revision_id",
            entity_uuid_type(),
            ForeignKey("skill_revisions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("path", Text, nullable=False),
        Column(
            "sha256",
            Text,
            ForeignKey("skill_blobs.sha256", ondelete="RESTRICT"),
            nullable=False,
        ),
        Column("bytes", BigInteger, nullable=False),
        CheckConstraint("bytes >= 0 AND bytes <= 1048576", name="ck_skill_files_bytes"),
        UniqueConstraint("revision_id", "path", name="uq_skill_files_path"),
        Index("ix_skill_files_sha256", "sha256"),
    )
    events_table = Table(
        "skill_events",
        metadata,
        database_id_column(),
        Column(
            "skill_id",
            entity_uuid_type(),
            ForeignKey("skills.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("sequence", BigInteger, nullable=False),
        Column("type", Text, nullable=False),
        Column("timestamp", DateTime(timezone=True), nullable=False),
        Column("payload", json_type(), nullable=False),
        UniqueConstraint("skill_id", "sequence", name="uq_skill_events_sequence"),
    )
    assignments = Table(
        "skill_assignments",
        metadata,
        database_id_column(),
        Column(
            "skill_id",
            entity_uuid_type(),
            ForeignKey("skills.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("target_type", Text, nullable=False),
        Column("target_id", Text, nullable=False),
        Column("mode", Text, nullable=False),
        Column("pin", json_type(), nullable=False),
        Column("invocation", Text, nullable=False),
        Column(
            "created_by_employee_id",
            entity_uuid_type(),
            ForeignKey("employees.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        CheckConstraint(
            "target_type IN ('employee', 'team', 'project', 'agent', 'org')",
            name="ck_skill_assignments_target_type",
        ),
        CheckConstraint(
            "mode IN ('optional', 'required', 'suggested')",
            name="ck_skill_assignments_mode",
        ),
        CheckConstraint(
            "invocation IN ('implicit', 'explicit')",
            name="ck_skill_assignments_invocation",
        ),
        UniqueConstraint(
            "skill_id",
            "target_type",
            "target_id",
            name="uq_skill_assignments_target",
        ),
        Index("ix_skill_assignments_target", "target_type", "target_id"),
        Index("ix_skill_assignments_skill", "skill_id"),
    )

    def __init__(
        self,
        database_url: str,
        *,
        object_store: SkillObjectStore,
        create_schema: bool = False,
    ):
        self.engine = shared_engine(database_url)
        self.object_store = object_store
        self._write_lock = RLock()
        if create_schema:
            create_all_tables(self.engine)

    def create_skill(
        self, owner_employee_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        files, manifest = _validate_files(payload.get("files"))
        name = _identity_part(payload.get("name"), "invalid-name")
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
                        "ownerEmployeeId": owner_employee_id,
                        "namespace": namespace,
                        "name": name,
                        "slug": slug,
                        "displayName": _display_name(payload.get("displayName"), name),
                        "description": manifest["description"],
                        "visibility": visibility,
                        "source": source,
                        "sourceRef": payload.get("sourceRef"),
                        "currentRevisionId": None,
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
                        owner_employee_id,
                        files,
                        payload.get("note"),
                    )
                    skill = {**skill, "currentRevisionId": revision["id"]}
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
                        {"revision": revision, "currentRevisionId": revision["id"]},
                    )
                return skill
            except IntegrityError as error:
                raise self._integrity_error(error) from error

    def add_revision(
        self,
        skill_id: str,
        created_by_employee_id: str,
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
                        created_by_employee_id,
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

    def get_skill(self, skill_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            exists = conn.scalar(
                select(self.skills.c.id).where(self.skills.c.id == skill_id)
            )
            return self._replay(conn, exists) if exists else None

    def list_skills(self, viewer_employee_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            ids = conn.scalars(
                select(self.skills.c.id).where(
                    self.skills.c.deleted_at.is_(None),
                    or_(
                        self.skills.c.visibility == "org",
                        self.skills.c.owner_employee_id == viewer_employee_id,
                    ),
                )
            ).all()
            result = [self._replay(conn, skill_id) for skill_id in ids]
        return sorted(
            result, key=lambda item: (item["displayName"].casefold(), item["id"])
        )

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

    def upsert_assignment(
        self,
        skill_id: str,
        *,
        target_type: str,
        target_id: str,
        mode: str,
        pin: str | dict[str, str],
        invocation: str,
        created_by_employee_id: str,
    ) -> dict[str, Any]:
        if target_type not in {"employee", "team", "project", "agent", "org"}:
            raise SkillValidationError("invalid-assignment-target")
        if not isinstance(target_id, str) or not target_id:
            raise SkillValidationError("invalid-assignment-target")
        if mode not in {"optional", "required", "suggested"}:
            raise SkillValidationError("invalid-assignment-mode")
        if invocation not in {"implicit", "explicit"}:
            raise SkillValidationError("invalid-invocation-policy")
        if pin not in {"latest", "stable"} and not (
            isinstance(pin, dict)
            and set(pin) == {"revisionId"}
            and isinstance(pin["revisionId"], str)
        ):
            raise SkillValidationError("invalid-pin")
        with self._write_lock, store_transaction(self.engine) as conn:
            skill_row = (
                conn.execute(
                    select(self.skills.c.id, self.skills.c.event_version)
                    .where(self.skills.c.id == skill_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not skill_row:
                raise KeyError(skill_id)
            existing = (
                conn.execute(
                    select(self.assignments).where(
                        self.assignments.c.skill_id == skill_id,
                        self.assignments.c.target_type == target_type,
                        self.assignments.c.target_id == target_id,
                    )
                )
                .mappings()
                .first()
            )
            timestamp = now_iso()
            assignment_id = str(existing["id"]) if existing else new_database_id()
            created_at = (
                _format_iso(existing["created_at"]) if existing else timestamp
            )
            assignment = {
                "id": assignment_id,
                "skillId": str(skill_id),
                "targetType": target_type,
                "targetId": target_id,
                "mode": mode,
                "pin": pin,
                "invocation": invocation,
                "createdByEmployeeId": created_by_employee_id,
                "createdAt": created_at,
                "updatedAt": timestamp,
            }
            values = _assignment_row(assignment)
            if existing:
                conn.execute(
                    update(self.assignments)
                    .where(self.assignments.c.id == existing["id"])
                    .values(**values)
                )
            else:
                conn.execute(insert(self.assignments).values(**values))
            self._record_assignment_event(
                conn,
                skill_row,
                "skill.assignment.upserted",
                {"assignment": assignment},
            )
            return assignment

    def get_assignment(self, assignment_id: str) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.assignments).where(
                        self.assignments.c.id == assignment_id
                    )
                )
                .mappings()
                .first()
            )
        return _assignment_dict(row) if row else None

    def list_assignments(
        self,
        *,
        skill_id: str | None = None,
        targets: list[tuple[str, str]] | None = None,
    ) -> list[dict[str, Any]]:
        statement = select(self.assignments)
        if skill_id is not None:
            statement = statement.where(self.assignments.c.skill_id == skill_id)
        if targets is not None:
            if not targets:
                return []
            statement = statement.where(
                or_(
                    *(
                        (self.assignments.c.target_type == target_type)
                        & (self.assignments.c.target_id == target_id)
                        for target_type, target_id in targets
                    )
                )
            )
        with store_transaction(self.engine) as conn:
            rows = conn.execute(statement).mappings().all()
        return sorted(
            (_assignment_dict(row) for row in rows),
            key=lambda item: (item["skillId"], item["targetType"], item["targetId"]),
        )

    def delete_assignment(self, assignment_id: str) -> dict[str, Any]:
        with self._write_lock, store_transaction(self.engine) as conn:
            assignment_row = (
                conn.execute(
                    select(self.assignments)
                    .where(self.assignments.c.id == assignment_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not assignment_row:
                raise KeyError(assignment_id)
            skill_row = (
                conn.execute(
                    select(self.skills.c.id, self.skills.c.event_version)
                    .where(self.skills.c.id == assignment_row["skill_id"])
                    .with_for_update()
                )
                .mappings()
                .one()
            )
            assignment = _assignment_dict(assignment_row)
            conn.execute(
                delete(self.assignments).where(
                    self.assignments.c.id == assignment_row["id"]
                )
            )
            self._record_assignment_event(
                conn,
                skill_row,
                "skill.assignment.revoked",
                {"assignment": assignment},
            )
            return assignment

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

    def list_revisions(self, skill_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.revisions)
                    .where(self.revisions.c.skill_id == skill_id)
                    .order_by(self.revisions.c.revision.desc())
                )
                .mappings()
                .all()
            )
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
                    .order_by(self.files.c.path)
                )
                .mappings()
                .all()
            )
        return [dict(row) for row in rows]

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
        return self.object_store.get(sha256) or row["content"]

    def events(self, skill_id: str) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(
                    select(self.events_table)
                    .where(self.events_table.c.skill_id == skill_id)
                    .order_by(self.events_table.c.sequence)
                )
                .mappings()
                .all()
            )
        if not rows:
            raise KeyError(skill_id)
        return [
            {
                "id": str(row["id"]),
                "skillId": skill_id,
                "type": row["type"],
                "timestamp": _format_iso(row["timestamp"]),
                **row["payload"],
            }
            for row in rows
        ]

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
        employee_id: str,
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
            "createdByEmployeeId": employee_id,
            "note": note,
        }
        conn.execute(
            insert(self.revisions).values(
                id=revision["id"],
                skill_id=skill_id,
                revision=number,
                manifest_sha256=revision["manifestSha256"],
                bytes=revision["bytes"],
                created_at=_parse_iso(timestamp),
                created_by_employee_id=employee_id,
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

    def _append_event(
        self,
        conn: Any,
        skill_id: str,
        sequence: int,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        conn.execute(
            insert(self.events_table).values(
                id=new_database_id(),
                skill_id=skill_id,
                sequence=sequence,
                type=event_type,
                timestamp=_parse_iso(now_iso()),
                payload=payload,
            )
        )

    def _record_assignment_event(
        self,
        conn: Any,
        skill_row: Any,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        sequence = int(skill_row["event_version"])
        claimed = conn.execute(
            update(self.skills)
            .where(
                self.skills.c.id == skill_row["id"],
                self.skills.c.event_version == sequence,
            )
            .values(event_version=sequence + 1)
        )
        if claimed.rowcount != 1:
            raise _SkillWriteConflict(str(skill_row["id"]))
        self._append_event(conn, skill_row["id"], sequence, event_type, payload)

    def _replay(self, conn: Any, skill_id: str) -> dict[str, Any]:
        rows = (
            conn.execute(
                select(self.events_table.c.type, self.events_table.c.payload)
                .where(self.events_table.c.skill_id == skill_id)
                .order_by(self.events_table.c.sequence)
            )
            .mappings()
            .all()
        )
        skill: dict[str, Any] | None = None
        for row in rows:
            payload = row["payload"]
            if row["type"] == "skill.created":
                skill = dict(payload["skill"])
            elif row["type"] == "skill.revision.added" and skill is not None:
                skill.update(
                    currentRevisionId=payload["currentRevisionId"],
                    updatedAt=payload.get(
                        "updatedAt", payload["revision"]["createdAt"]
                    ),
                )
                if payload.get("description") is not None:
                    skill["description"] = payload["description"]
            elif row["type"] == "skill.updated" and skill is not None:
                skill.update(payload["patch"])
                skill["updatedAt"] = payload["updatedAt"]
            elif row["type"] == "skill.deleted" and skill is not None:
                skill.update(
                    updatedAt=payload["updatedAt"], deletedAt=payload["deletedAt"]
                )
        if skill is None:
            raise RuntimeError(f"Skill {skill_id} has no creation event")
        return skill

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
        candidates = (
            [base]
            + ([f"{base}-{handle}"] if handle else [])
            + [f"{base}-{i}" for i in range(2, 1000)]
        )
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


def _skill_row(skill: dict[str, Any], *, event_version: int) -> dict[str, Any]:
    return {
        "id": skill["id"],
        "owner_employee_id": skill["ownerEmployeeId"],
        "namespace_key": skill.get("namespace") or "",
        "name_key": skill["name"],
        "slug": skill["slug"],
        "visibility": skill["visibility"],
        "snapshot": skill,
        "event_version": event_version,
        "created_at": _parse_iso(skill["createdAt"]),
        "updated_at": _parse_iso(skill["updatedAt"]),
        "deleted_at": _parse_iso(skill.get("deletedAt")),
    }


def _revision_dict(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "skillId": str(row["skill_id"]),
        "revision": row["revision"],
        "manifestSha256": row["manifest_sha256"],
        "bytes": row["bytes"],
        "createdAt": _format_iso(row["created_at"]),
        "createdByEmployeeId": str(row["created_by_employee_id"]),
        "note": row["note"],
    }


def _assignment_row(assignment: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": assignment["id"],
        "skill_id": assignment["skillId"],
        "target_type": assignment["targetType"],
        "target_id": assignment["targetId"],
        "mode": assignment["mode"],
        "pin": assignment["pin"],
        "invocation": assignment["invocation"],
        "created_by_employee_id": assignment["createdByEmployeeId"],
        "created_at": _parse_iso(assignment["createdAt"]),
        "updated_at": _parse_iso(assignment["updatedAt"]),
    }


def _assignment_dict(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "skillId": str(row["skill_id"]),
        "targetType": row["target_type"],
        "targetId": row["target_id"],
        "mode": row["mode"],
        "pin": row["pin"],
        "invocation": row["invocation"],
        "createdByEmployeeId": str(row["created_by_employee_id"]),
        "createdAt": _format_iso(row["created_at"]),
        "updatedAt": _format_iso(row["updated_at"]),
    }


def _validate_files(files: Any) -> tuple[list[dict[str, Any]], dict[str, str]]:
    if not isinstance(files, list):
        raise SkillValidationError("files-required")
    if len(files) > MAX_FILES:
        raise SkillValidationError("too-many-files")
    normalized, seen, total = [], set(), 0
    for entry in files:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("path"), str)
            or not isinstance(entry.get("content"), bytes)
        ):
            raise SkillValidationError("invalid-file")
        path, content = entry["path"], entry["content"]
        parts = path.split("/")
        if (
            not path
            or len(path) > 512
            or path.startswith("/")
            or "\\" in path
            or any(
                part in {"", ".", ".."} or not _PATH_PART.fullmatch(part)
                for part in parts
            )
        ):
            raise SkillValidationError("invalid-path", path)
        if path in seen:
            raise SkillValidationError("duplicate-path", path)
        if any(
            path.startswith(other + "/") or other.startswith(path + "/")
            for other in seen
        ):
            raise SkillValidationError("path-conflict", path)
        if len(content) > MAX_FILE_BYTES:
            raise SkillValidationError("file-too-large", path)
        total += len(content)
        seen.add(path)
        normalized.append({"path": path, "content": content})
    if total > MAX_REVISION_BYTES:
        raise SkillValidationError("revision-too-large")
    if "SKILL.md" not in seen:
        raise SkillValidationError("skill-md-required")
    normalized.sort(key=lambda item: item["path"])
    return normalized, _parse_frontmatter(
        next(item["content"] for item in normalized if item["path"] == "SKILL.md")
    )


def _parse_frontmatter(content: bytes) -> dict[str, str]:
    match = _FRONTMATTER.match(content)
    if not match or len(match.group(1)) > 65536:
        raise SkillValidationError("invalid-skill-md")
    try:
        values = yaml.safe_load(match.group(1).decode("utf-8"))
    except (UnicodeDecodeError, yaml.YAMLError, RecursionError) as error:
        raise SkillValidationError("invalid-skill-md") from error
    if not isinstance(values, dict):
        raise SkillValidationError("invalid-skill-md")
    if not isinstance(values.get("name"), str) or not values["name"].strip():
        raise SkillValidationError("skill-name-required")
    if not isinstance(values.get("description"), str) or not values["description"].strip():
        raise SkillValidationError("skill-description-required")
    return {
        "name": _identity_part(values["name"], "invalid-name"),
        "description": values["description"].strip(),
    }


def _identity_part(value: Any, code: str) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip().lower()
        or not _PART.fullmatch(value)
    ):
        raise SkillValidationError(code)
    return value


def _namespace(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or value != value.strip().lower():
        raise SkillValidationError("invalid-namespace")
    parts = value.split("/")
    if any(not _PART.fullmatch(part) for part in parts):
        raise SkillValidationError("invalid-namespace")
    return "/".join(parts)


def _required_text(value: Any, code: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SkillValidationError(code)
    return value.strip()


def _display_name(value: Any, name: str) -> str:
    return _required_text(value, "display-name-required") if value is not None else name


def _manifest_sha256(files: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for item in files:
        digest.update(item["path"].encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(item["content"]).hexdigest().encode())
        digest.update(b"\n")
    return digest.hexdigest()
