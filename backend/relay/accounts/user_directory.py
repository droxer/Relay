"""Filter and page the control panel's user roster and Computer assignments."""

from __future__ import annotations

from collections import defaultdict
from typing import Any
from unicodedata import combining, normalize

USER_FILTERS = ("all", "running", "ready", "idle", "failed", "unassigned")
USER_SORTS = ("user", "computers", "localLimit", "running", "ready")
USER_PAGE_SIZE = 25


def _flags(nodes: list[dict[str, Any]]) -> dict[str, int]:
    running = ready = failed = local = 0
    for node in nodes:
        stale = node.get("stale")
        if not isinstance(stale, bool):
            stale = not node.get("online")
        status = "stale" if stale else node.get("status")
        running += status == "running"
        ready += status == "ready"
        failed += status in ("failed", "stale")
        local += node.get("nodeLocation") == "user-device"
    return {"computers": len(nodes), "running": running, "ready": ready, "failed": failed, "localLimit": local}


def _matches_search(query: str, user_id: str, user: dict[str, Any], nodes: list[dict[str, Any]]) -> bool:
    if not query:
        return True
    haystack = " ".join([
        user_id, user.get("displayName") or user_id, user.get("email") or "", user.get("departmentName") or "",
        *(f"{node.get('displayName') or ''} {node['id']}" for node in nodes),
    ])
    return query in haystack.lower()


def user_directory_page(
    users: list[dict[str, Any]], nodes: list[dict[str, Any]], *,
    query: str, user_filter: str, sort: str, page: int,
) -> tuple[list[str], list[dict[str, Any]], dict[str, Any]]:
    by_id = {user["id"]: user for user in users}
    computers: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for node in nodes:
        if owner := node.get("userId"):
            computers[owner].append(node)
    counts = dict.fromkeys(USER_FILTERS, 0)
    visible: list[tuple[str, Any]] = []
    local_usage: dict[str, int] = {}
    sort_key = sort.removeprefix("-")
    for user_id in sorted(by_id.keys() | computers.keys()):
        user = by_id.get(user_id, {})
        user_nodes = computers[user_id]
        flags = _flags(user_nodes)
        local_usage[user_id] = flags["localLimit"]
        matches = {"all"}
        matches.update(key for key in ("running", "ready", "failed") if flags[key])
        if not user_nodes:
            matches.add("unassigned")
        elif len(matches) == 1:
            matches.add("idle")
        for key in matches:
            counts[key] += 1
        if user_filter not in matches or not _matches_search(query, user_id, user, user_nodes):
            continue
        value: str | int
        if sort_key == "user":
            name = user.get("displayName") or user_id
            value = "".join(char for char in normalize("NFD", name.casefold()) if not combining(char))
        else:
            value = flags.get(sort_key, 0)
        visible.append((user_id, value))
    if sort_key:
        visible.sort(key=lambda item: item[1], reverse=sort.startswith("-"))
    total = len(visible)
    page = max(1, min(page, (total + USER_PAGE_SIZE - 1) // USER_PAGE_SIZE))
    start = (page - 1) * USER_PAGE_SIZE
    ids = [user_id for user_id, _ in visible[start:start + USER_PAGE_SIZE]]
    return (
        [user_id for user_id in ids if user_id in by_id],
        [node for user_id in ids for node in computers[user_id]],
        {"page": {"page": page, "total": total}, "userCount": len(by_id), "counts": counts,
         "displayOrder": ids, "localUsage": {user_id: local_usage[user_id] for user_id in ids}},
    )
