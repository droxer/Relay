from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any

from .session_store import DatabaseSessionStore, artifact_snapshot_extension
from .store_common import _parse_iso, _read_json, _read_jsonl, materialize_events


def _content_bytes(content: str | None, metadata: dict[str, Any]) -> bytes | None:
    if content is None:
        return None
    if metadata.get("contentEncoding") == "base64":
        return base64.b64decode(content, validate=True)
    return content.encode("utf-8")


def _session_manifest(
    session: dict[str, Any],
    events: list[dict[str, Any]],
    contents: dict[str, tuple[str | None, dict[str, Any]]],
) -> dict[str, Any]:
    retained_bytes = 0
    content_hashes: dict[str, str | None] = {}
    for artifact in session.get("artifacts", []):
        artifact_id = str(artifact["id"])
        content, metadata = contents.get(artifact_id, (None, {}))
        data = _content_bytes(content, metadata)
        content_hashes[artifact_id] = (
            hashlib.sha256(data).hexdigest() if data is not None else None
        )
        retained_bytes += len(data) if data is not None else 0
    canonical_events = json.dumps(
        events, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    runs = session.get("agentRuns", [])
    return {
        "sessionId": session["id"],
        "eventCount": len(events),
        "artifactCount": len(session.get("artifacts", [])),
        "retainedArtifactBytes": retained_bytes,
        "completedRunCount": sum(bool(run.get("completedAt")) for run in runs),
        "tokenUsageRunCount": sum(isinstance(run.get("tokenUsage"), dict) for run in runs),
        "payloadHash": hashlib.sha256(canonical_events).hexdigest(),
        "artifactContentHashes": content_hashes,
    }


def _validate_events(session_id: str, events: list[dict[str, Any]]) -> None:
    if not events or events[0].get("type") != "session.created":
        raise ValueError("event log must start with session.created")
    seen: set[str] = set()
    previous_timestamp = None
    for event in events:
        if event.get("sessionId") != session_id:
            raise ValueError(f"event {event.get('id')} belongs to another session")
        event_id = event.get("id")
        if not isinstance(event_id, str) or not event_id or event_id in seen:
            raise ValueError(f"invalid or duplicate event id {event_id!r}")
        seen.add(event_id)
        if not isinstance(event.get("timestamp"), str):
            raise TypeError(f"event {event_id} has no timestamp")
        try:
            timestamp = _parse_iso(event["timestamp"])
        except (TypeError, ValueError) as error:
            raise ValueError(f"event {event_id} has an invalid timestamp") from error
        if timestamp is None:
            raise ValueError(f"event {event_id} has an invalid timestamp")
        if previous_timestamp is not None and timestamp < previous_timestamp:
            raise ValueError(f"event {event_id} has a non-monotonic timestamp")
        previous_timestamp = timestamp


def _artifact_contents(
    session_dir: Path, session: dict[str, Any]
) -> tuple[dict[str, tuple[str | None, dict[str, Any]]], list[str]]:
    result: dict[str, tuple[str | None, dict[str, Any]]] = {}
    warnings: list[str] = []
    for artifact in session.get("artifacts", []):
        artifact_id = str(artifact["id"])
        snapshot_path = artifact.get("snapshotPath")
        if artifact.get("kind") == "workspace_file" and not snapshot_path:
            warnings.append(f"{artifact_id}: metadata-only workspace artifact")
            result[artifact_id] = (None, {})
            continue
        raw_path = snapshot_path or artifact.get("path")
        if not raw_path:
            raise ValueError(f"{artifact_id}: retained content is missing")
        path = Path(str(raw_path))
        try:
            resolved = path.resolve()
            resolved.relative_to(session_dir.resolve())
        except OSError as error:
            raise ValueError(
                f"{artifact_id}: retained content path cannot be resolved"
            ) from error
        except ValueError as error:
            raise ValueError(
                f"{artifact_id}: retained content is outside the session directory"
            ) from error
        if not resolved.is_file():
            raise ValueError(f"{artifact_id}: retained content is missing")
        data = resolved.read_bytes()
        expected_bytes = artifact.get("bytes")
        if isinstance(expected_bytes, int) and expected_bytes != len(data):
            raise ValueError(
                f"{artifact_id}: retained content size mismatch "
                f"(expected {expected_bytes}, found {len(data)})"
            )
        metadata: dict[str, Any] = {
            "extension": artifact_snapshot_extension(artifact.get("title"))
        }
        if snapshot_path or artifact.get("kind") == "workspace_file":
            metadata["contentEncoding"] = "base64"
            result[artifact_id] = (base64.b64encode(data).decode("ascii"), metadata)
            continue
        try:
            result[artifact_id] = (data.decode("utf-8"), metadata)
        except UnicodeDecodeError:
            metadata["contentEncoding"] = "base64"
            result[artifact_id] = (base64.b64encode(data).decode("ascii"), metadata)
    return result, warnings


def migrate_local_sessions(
    source: str | Path,
    store: DatabaseSessionStore,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    sessions_dir = Path(source) / "sessions"
    report: dict[str, Any] = {
        "source": str(sessions_dir),
        "dryRun": dry_run,
        "discovered": 0,
        "imported": 0,
        "skipped": 0,
        "validated": 0,
        "warnings": [],
        "failures": [],
        "importedIds": [],
        "skippedIds": [],
        "validatedIds": [],
        "sessions": [],
        "totals": {
            "events": 0,
            "artifacts": 0,
            "retainedArtifactBytes": 0,
            "completedRuns": 0,
            "tokenUsageRuns": 0,
        },
    }
    if not sessions_dir.is_dir():
        raise ValueError(f"Legacy sessions directory does not exist: {sessions_dir}")
    reserved_event_ids: set[str] = set()
    reserved_artifact_ids: set[str] = set()
    for session_dir in sorted(
        path
        for path in sessions_dir.iterdir()
        if path.is_dir() and (path / "events.jsonl").is_file()
    ):
        report["discovered"] += 1
        session_id = session_dir.name
        try:
            events = _read_jsonl(session_dir / "events.jsonl")
            _validate_events(session_id, events)
            session = materialize_events(events)
            event_ids = {str(event["id"]) for event in events}
            artifact_ids = [
                str(artifact["id"]) for artifact in session.get("artifacts", [])
            ]
            duplicate_event_ids = event_ids.intersection(reserved_event_ids)
            if duplicate_event_ids:
                raise ValueError(
                    "event IDs are reused across legacy sessions: "
                    + ", ".join(sorted(duplicate_event_ids))
                )
            if len(set(artifact_ids)) != len(artifact_ids):
                raise ValueError("legacy session contains duplicate artifact IDs")
            duplicate_artifact_ids = set(artifact_ids).intersection(
                reserved_artifact_ids
            )
            if duplicate_artifact_ids:
                raise ValueError(
                    "artifact IDs are reused across legacy sessions: "
                    + ", ".join(sorted(duplicate_artifact_ids))
                )
            reserved_event_ids.update(event_ids)
            reserved_artifact_ids.update(artifact_ids)
            contents, warnings = _artifact_contents(session_dir, session)
            report["warnings"].extend(
                {"sessionId": session_id, "message": warning} for warning in warnings
            )
            snapshot_path = session_dir / "snapshot.json"
            if snapshot_path.exists():
                snapshot = _read_json(snapshot_path)
                if snapshot != session:
                    report["warnings"].append(
                        {
                            "sessionId": session_id,
                            "message": "snapshot drift; imported event-derived state",
                        }
                    )
            manifest = _session_manifest(session, events, contents)
            report["sessions"].append(manifest)
            report["totals"]["events"] += manifest["eventCount"]
            report["totals"]["artifacts"] += manifest["artifactCount"]
            report["totals"]["retainedArtifactBytes"] += manifest[
                "retainedArtifactBytes"
            ]
            report["totals"]["completedRuns"] += manifest["completedRunCount"]
            report["totals"]["tokenUsageRuns"] += manifest["tokenUsageRunCount"]
            outcome = (
                store.validate_import_session(events, contents)
                if dry_run
                else store.import_session(events, contents)
            )
            report[outcome] += 1
            report[f"{outcome}Ids"].append(session_id)
        except Exception as error:  # noqa: BLE001 - report each corrupt legacy session
            report["failures"].append({"sessionId": session_id, "message": str(error)})
    return report
