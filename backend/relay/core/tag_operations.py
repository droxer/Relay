"""Rename, merge, and delete in a person's tag catalog: the pure rules.

An operation names tags by any spelling; it matches by the casefold identity
``task_tags`` already gives a tag, and it writes the spelling the person
typed. ``rewrite_tags`` is what one record's tag list becomes, or ``None``
when the operation does not touch it. Rename and merge never add a tag to a
list, so a record never exceeds ``MAX_TAGS``. ``relay/tags/catalog.py``
decides which records an operation may reach.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .task_tags import normalize_tag

OPERATIONS = ("rename", "merge", "delete")
MAX_MERGE_SOURCES = 20


class TagOperationError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class TagOperation:
    kind: str
    # Every tag the operation takes away, by casefold key.
    source_keys: tuple[str, ...]
    source_names: tuple[str, ...]
    # The spelling written in their place; None for delete.
    new_name: str | None

    @property
    def new_key(self) -> str | None:
        return self.new_name.casefold() if self.new_name is not None else None

    def public(self) -> dict[str, Any]:
        if self.kind == "rename":
            return {"operation": "rename", "name": self.source_names[0], "newName": self.new_name}
        if self.kind == "merge":
            return {"operation": "merge", "sources": list(self.source_names), "target": self.new_name}
        return {"operation": "delete", "name": self.source_names[0]}


def tag_name(value: Any) -> str:
    """``normalize_tag`` answering with this module's error code."""
    try:
        return normalize_tag(value)
    except ValueError as error:
        raise TagOperationError("tag_invalid") from error


def parse_tag_operation(body: Any) -> TagOperation:
    if not isinstance(body, dict) or body.get("operation") not in OPERATIONS:
        raise TagOperationError("tag_operation_invalid")
    kind = body["operation"]
    if kind == "delete":
        name = tag_name(body.get("name"))
        return TagOperation("delete", (name.casefold(),), (name,), None)
    if kind == "rename":
        name, new_name = tag_name(body.get("name")), tag_name(body.get("newName"))
        if name == new_name:
            raise TagOperationError("tag_unchanged")
        return TagOperation("rename", (name.casefold(),), (name,), new_name)
    return _parse_merge(body)


def _parse_merge(body: dict[str, Any]) -> TagOperation:
    sources = body.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= MAX_MERGE_SOURCES:
        raise TagOperationError("tag_operation_invalid")
    target = tag_name(body.get("target"))
    names: list[str] = []
    keys: list[str] = []
    for raw in sources:
        name = tag_name(raw)
        key = name.casefold()
        if key != target.casefold() and key not in keys:
            keys.append(key)
            names.append(name)
    if not keys:
        raise TagOperationError("tag_operation_invalid")
    return TagOperation("merge", tuple(keys), tuple(names), target)


def rewrite_tags(tags: list[str], operation: TagOperation) -> list[str] | None:
    """``tags`` after ``operation``, or None when it names none of ``tags``.

    A list holding only the merge target keeps that target's spelling."""
    if not any(tag.casefold() in operation.source_keys for tag in tags):
        return None
    replaced = set(operation.source_keys)
    if operation.new_key is not None:
        replaced.add(operation.new_key)
    result: list[str] = []
    placed = False
    for tag in tags:
        if tag.casefold() not in replaced:
            result.append(tag)
        elif operation.new_name is not None and not placed:
            result.append(operation.new_name)
            placed = True
    return None if result == tags else result
