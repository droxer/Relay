"""A person's tag catalog: list, save, and rename/merge/delete across their work.

The catalog is the names a person saved plus every tag on the live Tasks and
Automations they own, the same records ``GET /tasks`` lists, so a count never
depends on a page. An operation reaches only records whose project, if any,
is still the owner's and still takes work (``project_for_owner``, the rule a
task PATCH applies); the rest are reported as excluded and left alone.

An operation is previewed, then applied. The preview's token fingerprints the
records it would change (id, version, outcome), the ones it excludes, and the
saved names. Applying re-reads that state under a per-person lock with the
affected rows held for update and refuses a token that no longer matches, so a
preview never authorizes a record it did not show. Every record change is a new
``task.updated`` event; all of them and the catalog change commit together.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

from ..core.tag_operations import (
    TagOperation,
    TagOperationError,
    parse_tag_operation,
    rewrite_tags,
    tag_name,
)
from ..persistence.engine import store_transaction
from ..persistence.resource_lock import resource_transaction
from ..projects.access import ProjectAccessError, project_for_owner

# Each preview list names this many records; its counts always cover all.
PREVIEW_ITEM_LIMIT = 50
MAX_SAVED_TAGS = 500
_EXCLUSION_REASONS = {403: "project_not_owned", 404: "project_unavailable"}


class TagCatalogError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class _Plan:
    operation: TagOperation
    affected: list[dict[str, Any]]
    excluded: list[dict[str, Any]]
    removed_saved: list[str]
    token: str


def list_tags(task_store: Any, owner: str, query: str = "") -> list[dict[str, Any]]:
    """Every tag ``owner`` has, by name; ``query`` keeps names containing it."""
    needle = " ".join(query.split()).casefold()
    entries = _catalog(task_store.saved_tags(owner), task_store.tag_usage_rows(owner))
    return [entry for entry in entries.values() if needle in entry["name"].casefold()]


def create_tag(task_store: Any, owner: str, raw_name: Any) -> dict[str, Any]:
    name = _checked(tag_name, raw_name)
    with resource_transaction(task_store.engine, _lock_key(owner)):
        saved = task_store.saved_tags(owner)
        if name.casefold() in _catalog(saved, task_store.tag_usage_rows(owner)):
            raise TagCatalogError(409, "tag_exists")
        if len(saved) >= MAX_SAVED_TAGS:
            raise TagCatalogError(409, "tag_catalog_full")
        if not task_store.save_tag(owner, name):
            raise TagCatalogError(409, "tag_exists")
    return {"name": name, "taskCount": 0, "automationCount": 0, "saved": True}


def preview_tag_operation(
    task_store: Any, project_store: Any, owner: str, body: Any
) -> dict[str, Any]:
    operation = _checked(parse_tag_operation, body)
    with store_transaction(task_store.engine):
        plan = _plan(task_store, project_store, owner, operation, lock=False)
    return {
        "operation": operation.public(),
        "previewToken": plan.token,
        "affected": _summary(plan.affected),
        "excluded": _summary(plan.excluded),
        "catalog": {"removes": plan.removed_saved, "saves": operation.new_name},
    }


def apply_tag_operation(
    task_store: Any, project_store: Any, owner: str, body: Any
) -> dict[str, Any]:
    operation = _checked(parse_tag_operation, body)
    token = body.get("previewToken") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token:
        raise TagCatalogError(400, "tag_preview_required")
    with resource_transaction(task_store.engine, _lock_key(owner)):
        try:
            plan = _plan(task_store, project_store, owner, operation, lock=True)
        except TagCatalogError as error:
            # The previewed tags changed since: another apply renamed or saved one.
            raise TagCatalogError(409, "tag_preview_stale") from error
        if not hmac.compare_digest(plan.token.encode(), token.encode()):
            raise TagCatalogError(409, "tag_preview_stale")
        for item in plan.affected:
            task_store.rewrite_task_tags(
                item["id"], item["tagsAfter"], actor_user_id=owner, operation=operation.kind
            )
        task_store.replace_saved_tags(owner, list(operation.source_keys), operation.new_name)
    return {
        "operation": operation.public(),
        "updated": _counts(plan.affected),
        "excluded": _counts(plan.excluded),
        "tags": list_tags(task_store, owner),
    }


def _plan(
    task_store: Any, project_store: Any, owner: str, operation: TagOperation, *, lock: bool
) -> _Plan:
    saved = task_store.saved_tags(owner)
    rows = task_store.tag_usage_rows(owner)
    known = _catalog(saved, rows)
    if any(key not in known for key in operation.source_keys):
        raise TagCatalogError(404, "tag_not_found")
    new_key = operation.new_key
    if operation.kind == "rename" and new_key != operation.source_keys[0] and new_key in known:
        raise TagCatalogError(409, "tag_exists")
    matching = [row for row in rows if rewrite_tags(row["tags"], operation) is not None]
    if lock:
        # Hold the matching rows, then judge them as they are now.
        locked = task_store.tag_usage_rows(owner, lock_ids=[row["id"] for row in matching])
        matching = [row for row in locked if rewrite_tags(row["tags"], operation) is not None]
    reasons: dict[str, str | None] = {}
    affected: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for row in matching:
        reason = _exclusion(project_store, owner, row["projectId"], reasons)
        item = _item(row, operation)
        if reason:
            excluded.append({**item, "reason": reason})
        else:
            affected.append(item)
    removed_saved = [entry["name"] for entry in saved if entry["key"] in operation.source_keys]
    return _Plan(operation, affected, excluded, removed_saved,
                 _token(owner, operation, affected, excluded, saved))


def _exclusion(
    project_store: Any, owner: str, project_id: str | None, cache: dict[str, str | None]
) -> str | None:
    if not project_id:
        return None
    if project_id not in cache:
        try:
            project_for_owner(project_store, project_id, owner, require_enabled=True)
            cache[project_id] = None
        except ProjectAccessError as error:
            cache[project_id] = _EXCLUSION_REASONS.get(error.status, "project_disabled")
    return cache[project_id]


def _item(row: dict[str, Any], operation: TagOperation) -> dict[str, Any]:
    return {
        "id": row["id"],
        "number": row["number"],
        "title": row["title"],
        "isRoutine": row["isRoutine"],
        "version": row["version"],
        "tagsBefore": list(row["tags"]),
        "tagsAfter": rewrite_tags(row["tags"], operation) or [],
    }


def _summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        **_counts(items),
        "items": [
            {key: value for key, value in item.items() if key != "version"}
            for item in items[:PREVIEW_ITEM_LIMIT]
        ],
        "itemsTruncated": len(items) > PREVIEW_ITEM_LIMIT,
    }


def _counts(items: list[dict[str, Any]]) -> dict[str, int]:
    automations = sum(1 for item in items if item["isRoutine"])
    return {"taskCount": len(items) - automations, "automationCount": automations}


def _token(
    owner: str, operation: TagOperation, affected: list[dict[str, Any]],
    excluded: list[dict[str, Any]], saved: list[dict[str, str]],
) -> str:
    state = {
        "owner": owner,
        "operation": operation.public(),
        "affected": [[item["id"], item["version"], item["tagsAfter"]] for item in affected],
        "excluded": [[item["id"], item["version"], item["reason"]] for item in excluded],
        "saved": [[entry["key"], entry["name"]] for entry in saved],
    }
    return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()


def _catalog(
    saved: list[dict[str, str]], rows: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Each tag by key: the saved spelling, else the most used one on work."""
    spellings: dict[str, Counter[str]] = defaultdict(Counter)
    counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for row in rows:
        for key, spelling in {tag.casefold(): tag for tag in reversed(row["tags"])}.items():
            spellings[key][spelling] += 1
            counts[key][1 if row["isRoutine"] else 0] += 1
    names = {key: min(found, key=lambda name: (-found[name], name)) for key, found in spellings.items()}
    names.update({entry["key"]: entry["name"] for entry in saved})
    saved_keys = {entry["key"] for entry in saved}
    return {
        key: {"name": names[key], "taskCount": counts[key][0],
              "automationCount": counts[key][1], "saved": key in saved_keys}
        for key in sorted(names, key=lambda key: (key, names[key]))
    }


def _checked(parse: Any, value: Any) -> Any:
    try:
        return parse(value)
    except TagOperationError as error:
        raise TagCatalogError(400, error.code) from error


def _lock_key(owner: str) -> str:
    return f"user-tags:{owner}"
