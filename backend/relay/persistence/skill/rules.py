"""Skill bundle validation: names, paths, SKILL.md frontmatter, size caps."""

from __future__ import annotations

import hashlib
import re
from typing import Any

import yaml

MAX_FILES = 300
MAX_FILE_BYTES = 1_048_576
MAX_REVISION_BYTES = 4_194_304
_PART = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")
_SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_PATH_PART = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$")
_FRONTMATTER = re.compile(
    rb"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL
)
_FRONTMATTER_FIELDS = {
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
}


class SkillValidationError(ValueError):
    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


def _validate_files(files: Any) -> tuple[list[dict[str, Any]], dict[str, str]]:
    if not isinstance(files, list):
        raise SkillValidationError("files-required")
    if len(files) > MAX_FILES:
        raise SkillValidationError("too-many-files")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    total = 0
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
    if any(not isinstance(key, str) for key in values):
        raise SkillValidationError("unexpected-frontmatter-field")
    if set(values) - _FRONTMATTER_FIELDS:
        raise SkillValidationError("unexpected-frontmatter-field")
    if not isinstance(values.get("name"), str) or not values["name"].strip():
        raise SkillValidationError("skill-name-required")
    if not isinstance(values.get("description"), str) or not values["description"].strip():
        raise SkillValidationError("skill-description-required")
    description = values["description"].strip()
    if len(description) > 1024:
        raise SkillValidationError("skill-description-too-long")
    if "license" in values and (
        not isinstance(values["license"], str) or not values["license"].strip()
    ):
        raise SkillValidationError("invalid-license")
    if "compatibility" in values and (
        not isinstance(values["compatibility"], str)
        or not values["compatibility"].strip()
        or len(values["compatibility"]) > 500
    ):
        raise SkillValidationError("invalid-compatibility")
    metadata = values.get("metadata")
    if metadata is not None and (
        not isinstance(metadata, dict)
        or any(
            not isinstance(key, str) or not isinstance(value, str)
            for key, value in metadata.items()
        )
    ):
        raise SkillValidationError("invalid-metadata")
    allowed_tools = values.get("allowed-tools")
    if allowed_tools is not None and (
        not isinstance(allowed_tools, str)
        or not allowed_tools.strip()
        or "\n" in allowed_tools
        or "\r" in allowed_tools
    ):
        raise SkillValidationError("invalid-allowed-tools")
    return {
        "name": _skill_name(values["name"]),
        "description": description,
    }


def _skill_name(value: Any) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip().lower()
        or len(value) > 64
        or not _SKILL_NAME.fullmatch(value)
    ):
        raise SkillValidationError("invalid-name")
    return value


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
