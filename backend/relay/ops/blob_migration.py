"""Move bytes already stored in Postgres or the data dir into the blob store.

Run once after turning on ``RELAY_BLOB_STORE=r2`` (``relay
migrate-blobs-to-r2``). New writes already go to the blob store; this moves
what was written before:

* workspace-artifact snapshots kept base64-inline in ``session_artifacts``;
* skill objects kept in the legacy ``skill_blobs.content`` column;
* skill objects in ``<data dir>/skills/objects``.

Each item is uploaded before its row changes, and a row is cleared only while
it still holds the bytes that were uploaded, so the command can be interrupted
and re-run at any point. Nothing in the data dir is deleted; once the command
reports nothing left to move, the volume can be detached.
"""

from __future__ import annotations

import base64
import binascii
from pathlib import Path
from typing import Any

from loguru import logger
from sqlalchemy import select, update

from ..persistence.session.artifact_blobs import artifact_blob_key, blob_metadata
from ..persistence.blob.store import BlobStore
from ..persistence.session.store import DatabaseSessionStore
from ..persistence.skill.objects import BlobSkillObjectStore, LocalSkillObjectStore
from ..persistence.skill.store import DatabaseSkillStore
from ..persistence.engine import store_transaction

_BATCH = 100


def migrate_blobs(
    database_url: str,
    blob_store: BlobStore,
    *,
    data_dir: str | Path | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    sessions = DatabaseSessionStore(database_url)
    skill_objects = BlobSkillObjectStore(blob_store)
    skills = DatabaseSkillStore(database_url, object_store=skill_objects)
    artifacts, skipped = _migrate_artifact_snapshots(sessions, blob_store, dry_run=dry_run)
    report = {
        "dryRun": dry_run,
        "artifactSnapshots": artifacts,
        "skippedArtifactSnapshots": skipped,
        "databaseSkillObjects": _migrate_database_skill_objects(skills, skill_objects, dry_run=dry_run),
        "dataDirSkillObjects": (
            _migrate_data_dir_skill_objects(Path(data_dir), skill_objects, dry_run=dry_run)
            if data_dir is not None
            else 0
        ),
    }
    logger.info("Blob migration finished", **report)
    return report


def _migrate_artifact_snapshots(
    store: DatabaseSessionStore, blob_store: BlobStore, *, dry_run: bool
) -> tuple[int, int]:
    table = store.artifacts
    moved = skipped = 0
    last_id: Any = None
    while True:
        query = (
            select(table.c.id, table.c.session_id, table.c.content, table.c.content_type, table.c.metadata)
            .where(table.c.content.isnot(None))
            .order_by(table.c.id)
            .limit(_BATCH)
        )
        if last_id is not None:
            query = query.where(table.c.id > last_id)
        with store_transaction(store.engine) as conn:
            rows = conn.execute(query).mappings().all()
        if not rows:
            return moved, skipped
        last_id = rows[-1]["id"]
        for row in rows:
            metadata = dict(row["metadata"] or {})
            # Other inline artifacts (text the backend wrote itself) are not
            # snapshots and stay where they are.
            if metadata.get("contentEncoding") != "base64":
                continue
            try:
                content = base64.b64decode(row["content"], validate=True)
            except (binascii.Error, ValueError):
                logger.warning("Skipping an artifact snapshot that is not valid base64", artifact_id=str(row["id"]))
                skipped += 1
                continue
            moved += 1
            if dry_run:
                continue
            key = artifact_blob_key(str(row["session_id"]), str(row["id"]))
            blob_store.put(key, content, content_type=row["content_type"])
            metadata.pop("contentEncoding")
            metadata.update(blob_metadata(key, content))
            with store_transaction(store.engine) as conn:
                conn.execute(
                    update(table)
                    .where(table.c.id == row["id"], table.c.content == row["content"])
                    .values(content=None, metadata=metadata)
                )


def _migrate_database_skill_objects(
    store: DatabaseSkillStore, objects: BlobSkillObjectStore, *, dry_run: bool
) -> int:
    table = store.blobs
    moved = 0
    last_digest = ""
    while True:
        with store_transaction(store.engine) as conn:
            rows = conn.execute(
                select(table.c.sha256, table.c.content)
                .where(table.c.content.isnot(None), table.c.sha256 > last_digest)
                .order_by(table.c.sha256)
                .limit(_BATCH)
            ).mappings().all()
        if not rows:
            return moved
        last_digest = rows[-1]["sha256"]
        for row in rows:
            moved += 1
            if dry_run:
                continue
            objects.put(row["sha256"], bytes(row["content"]))
            with store_transaction(store.engine) as conn:
                conn.execute(update(table).where(table.c.sha256 == row["sha256"]).values(content=None))


def _migrate_data_dir_skill_objects(
    data_dir: Path, objects: BlobSkillObjectStore, *, dry_run: bool
) -> int:
    local = LocalSkillObjectStore(data_dir / "skills" / "objects")
    if not local.root.is_dir():
        return 0
    moved = 0
    for path in sorted(local.root.glob("*/*")):
        digest = path.parent.name + path.name
        if path.name.startswith(".") or len(digest) != 64:
            continue  # An interrupted write's temporary file.
        if objects.exists(digest):
            continue
        moved += 1
        if dry_run:
            continue
        content = local.get(digest)
        if content is not None:
            objects.put(digest, content)
    return moved
