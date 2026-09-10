from __future__ import annotations

import base64
import mimetypes
import os
import re
from pathlib import Path, PurePosixPath
from typing import Any

from ..core.environment import load_backend_env

load_backend_env()

# ".key" is deliberately absent: it matches TLS/SSH private keys far more
# often than Keynote decks, and indexed files become downloadable artifacts.
GENERATED_ARTIFACT_EXTENSIONS = frozenset(
    {
        ".csv",
        ".doc",
        ".docx",
        ".gif",
        ".html",
        ".jpeg",
        ".jpg",
        ".pdf",
        ".png",
        ".ppt",
        ".pptx",
        ".svg",
        ".tsv",
        ".webp",
        ".xls",
        ".xlsx",
        ".zip",
    }
)
OUTPUT_ARTIFACT_TEXT_EXTENSIONS = frozenset({".json", ".log", ".md", ".txt"})
GENERATED_ARTIFACT_LIMIT = 200
# Per-file cap for content snapshots kept alongside the artifact record.
WORKSPACE_ARTIFACT_CONTENT_MAX_BYTES = int(
    os.environ.get("RELAY_WORKSPACE_ARTIFACT_SNAPSHOT_MAX_BYTES", str(2 * 1024 * 1024))
)


SNAPSHOT_SKIPPED_REASONS = frozenset(
    {"too-large", "not-snapshotable-type", "sensitive", "unreadable"}
)

# Mirrors SENSITIVE_FILE_NAME in packages/relay-daemon/src/generated-files.ts.
# Defence in depth: the daemon already drops these, and the backend drops them
# again so a compromised or stale daemon cannot register a credential's name.
SENSITIVE_FILE_NAME = re.compile(
    r"(?:^|[._-])(credential|credentials|secret|secrets|token|tokens|password"
    r"|passwd|api[._-]?key|private[._-]?key)(?:[._-]|$)",
    re.IGNORECASE,
)
# Private-key filenames: no bytes are ever attached, but the filename itself
# reaches the UI, so these are excluded outright rather than merely denied
# storage. Mirrors SENSITIVE_FILE_EXACT_NAMES / SENSITIVE_FILE_EXTENSIONS in
# packages/relay-daemon/src/generated-files.ts.
SENSITIVE_FILE_EXACT_NAMES = frozenset({"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"})
SENSITIVE_FILE_EXTENSIONS = frozenset(
    {".key", ".pem", ".p12", ".pfx", ".keystore", ".jks"}
)


def _is_sensitive_name(name: str) -> bool:
    if name == ".env" or name.startswith(".env."):
        return True
    if name in SENSITIVE_FILE_EXACT_NAMES:
        return True
    if PurePosixPath(name).suffix.lower() in SENSITIVE_FILE_EXTENSIONS:
        return True
    return bool(SENSITIVE_FILE_NAME.search(name))


def is_produced_file_path(relative_path: str) -> bool:
    """Whether a run-changed workspace path earns a produced-file record.

    Permissive by design: any file a run touched is that run's output. Only a
    credential-*named* file is refused, because the name itself is a leak.
    Mirrored in ``isExcludedByName``
    (packages/relay-daemon/src/generated-files.ts); change both together.
    """
    return not _is_sensitive_name(PurePosixPath(relative_path).name)


def is_snapshotable_path(relative_path: str) -> bool:
    """Whether a produced file's bytes may be stored and served.

    Binary/document types count anywhere. Text documents count only near a
    workspace root: directly in the thread workspace, directly in an agent's
    own home, or under an ``output/`` directory in either — so a guide an agent
    writes beside its work is stored while a checkout's ``README.md`` is not.
    This set has deliberately not widened along with candidacy: it is the
    surface the secret scanner was audited against. Mirrored in
    ``isSnapshotableFile`` (packages/relay-daemon/src/generated-files.ts);
    change both together.
    """
    path = PurePosixPath(relative_path)
    suffix = path.suffix.lower()
    if suffix in GENERATED_ARTIFACT_EXTENSIONS:
        return True
    if suffix not in OUTPUT_ARTIFACT_TEXT_EXTENSIONS:
        return False
    parts = path.parts
    if len(parts) >= 3 and parts[0] == "agents" and parts[1].startswith("agent-"):
        parts = parts[2:]
    return len(parts) == 1 or parts[0] == "output"


def _clean_workspace_relative_path(value: Any) -> str | None:
    """Validate a daemon-reported workspace-relative path (untrusted input)."""
    if not isinstance(value, str) or not value.strip():
        return None
    relative = PurePosixPath(value.strip().replace("\\", "/"))
    if relative.is_absolute():
        return None
    parts = relative.parts
    if not parts or any(part in ("..", ".") for part in parts):
        return None
    return relative.as_posix()


def _reported_file_size(raw: dict[str, Any], content: bytes | None) -> int:
    if content is not None:
        return len(content)
    size = raw.get("bytes")
    return size if isinstance(size, int) and size >= 0 else 0


def daemon_reported_generated_files(
    workspace_path: str | None,
    raw_files: list[Any],
    *,
    produced_files: bool = False,
) -> list[dict[str, Any]]:
    """Sanitize a daemon generated-file report into indexable items.

    ``produced_files`` reflects the reporting daemon's capability. Without it
    the older document-only rule decides candidacy, so an un-upgraded daemon
    indexes exactly as it always did.
    """
    items: list[dict[str, Any]] = []
    for raw in raw_files:
        if not isinstance(raw, dict):
            continue
        relative = _clean_workspace_relative_path(raw.get("relativePath"))
        if not relative:
            continue
        if not (
            is_produced_file_path(relative)
            if produced_files
            else is_snapshotable_path(relative)
        ):
            continue
        title = (
            raw["title"]
            if isinstance(raw.get("title"), str) and raw["title"].strip()
            else PurePosixPath(relative).name
        )
        content: bytes | None = None
        skipped: str | None = None
        if not is_snapshotable_path(relative):
            # Never trust a daemon's storage decision: re-derive it here, so
            # bytes for a path outside the allowlist are dropped on arrival.
            skipped = "not-snapshotable-type"
        else:
            encoded = raw.get("contentBase64")
            if isinstance(encoded, str) and encoded:
                try:
                    decoded = base64.b64decode(encoded, validate=True)
                except (ValueError, TypeError):
                    decoded = None
                if (
                    decoded is not None
                    and len(decoded) <= WORKSPACE_ARTIFACT_CONTENT_MAX_BYTES
                ):
                    content = decoded
                else:
                    skipped = "too-large"
            else:
                reported = raw.get("snapshotSkipped")
                skipped = (
                    reported
                    if reported in SNAPSHOT_SKIPPED_REASONS
                    else "not-snapshotable-type"
                )
        content_type = raw.get("contentType")
        if not isinstance(content_type, str) or not content_type:
            content_type = mimetypes.guess_type(title)[0] or "application/octet-stream"
        items.append(
            {
                "path": str(Path(workspace_path) / relative)
                if workspace_path
                else relative,
                "relativePath": relative,
                "title": title,
                "bytes": _reported_file_size(raw, content),
                "contentType": content_type,
                "content": content,
                "snapshotSkipped": skipped,
            }
        )
        if len(items) >= GENERATED_ARTIFACT_LIMIT:
            break
    return items
