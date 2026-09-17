"""One-time, non-destructive import of legacy local operational records."""

from __future__ import annotations

import base64
import hashlib
from pathlib import Path
from typing import Any

from .managed_node_store import DatabaseManagedNodeStore
from .profile_image_store import DatabaseProfileImageStore, LocalProfileImageStore
from .store_common import _read_json


def _source_id(root: Path) -> str:
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()


def local_operational_state_present(root: Path) -> bool:
    return any((root / "managed-nodes").glob("*/*.json")) or any(
        (root / "profile-images").glob("*/*.*")
    )


def require_operational_import(root: Path, store: DatabaseManagedNodeStore) -> None:
    if local_operational_state_present(root) and not store._read_record(
        "imports", _source_id(root)
    ):
        raise RuntimeError(
            "Local managed-node/profile-image state must be imported before startup. "
            "Run relay migrate-local-operational-state --data-dir <existing-data-dir> "
            "with the configured database (use --dry-run to preview)."
        )


def migrate_local_operational_state(
    root_dir: str | Path, database_url: str, *, dry_run: bool = False
) -> dict[str, Any]:
    root = Path(root_dir)
    managed = DatabaseManagedNodeStore(database_url)
    images = DatabaseProfileImageStore(database_url)
    local_images = LocalProfileImageStore(root)
    source_id = _source_id(root)
    counts = {"nodes": 0, "attempts": 0, "grants": 0, "images": 0}
    # Stop legacy writers before import. The policy transaction serializes
    # imports; rollback on conflict preserves both the DB and source files.
    with managed._policy_slot_lock():
        if managed._read_record("imports", source_id):
            return {"alreadyImported": True, "dryRun": dry_run, **counts}
        for kind, directory in (
            ("nodes", "nodes"),
            ("attempts", "attempts"),
            ("grants", "enrollment-grants"),
        ):
            for path in sorted((root / "managed-nodes" / directory).glob("*.json")):
                record = _read_json(path)
                existing = managed._read_record(kind, record["id"])
                if existing is not None and existing != record:
                    raise ValueError(f"Conflicting {kind} record: {record['id']}")
                if not dry_run and existing is None:
                    managed._write_record(kind, record)
                counts[kind] += 1
        for kind in ("agents", "teams"):
            ids = {path.stem for path in (root / "profile-images" / kind).glob("*.*")}
            for entity_id in sorted(ids):
                image = local_images.read(kind, entity_id)
                if image is None:
                    continue
                existing = images.read(kind, entity_id)
                if existing is not None and existing != image:
                    raise ValueError(f"Conflicting profile image: {kind}/{entity_id}")
                if not dry_run and existing is None:
                    content, mime, _ = image
                    images.save(
                        kind,
                        entity_id,
                        f"data:{mime};base64,{base64.b64encode(content).decode()}",
                    )
                counts["images"] += 1
        if not dry_run:
            managed._write_record("imports", {"id": source_id})
    return {"alreadyImported": False, "dryRun": dry_run, **counts}
