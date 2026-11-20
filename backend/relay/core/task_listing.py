"""Ordering and numbered windows shared by Task lists."""

from collections.abc import Mapping
from typing import Any
from unicodedata import combining, normalize


def task_list_text_order(value: str) -> str:
    return "".join(char for char in normalize("NFD", value.casefold()) if not combining(char))


def task_list_window[T](rows: list[T], requested_page: int, size: int) -> tuple[list[T], dict[str, int]]:
    page = min(requested_page, max(1, (len(rows) + size - 1) // size))
    start = (page - 1) * size
    return rows[start:start + size], {"page": page, "total": len(rows)}


def task_list_assignee(
    row: Mapping[str, Any], *, missing_agent: str, missing_team: str, workflow: str, unassigned: str,
) -> str:
    if row["team_id"]:
        return row["team_name"] or missing_team
    if row["agent_id"]:
        return row["agent_name"] or missing_agent
    if row["workflow"]:
        return workflow
    return row["agent"] or unassigned
