"""Filter and page Automation definitions by schedule state."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .task_listing import task_list_assignee, task_list_text_order, task_list_window

AUTOMATION_LIST_STATES = ("running", "due", "scheduled", "listening", "on_demand", "completed", "paused")
AUTOMATION_LIST_SORTS = ("title", "priority", "assignee", "nextRun")
LIVE_OCCURRENCE_STATUSES = ("assigned", "queued", "running", "review")
RUNNING_OCCURRENCE_STATUSES = ("running", "review")


@dataclass(frozen=True)
class AutomationListRequest:
    owner: str
    now: datetime
    project_id: str = ""
    computer_id: str = ""
    search: str = ""
    tag: str = ""
    agent: str = ""
    assignee: str = ""
    trigger: str = ""
    state: str = ""
    sort: str = ""
    page: int = 1
    unplaced_page: int = 1
    missing_agent: str = "Unavailable agent"
    missing_team: str = "Unavailable team"
    workflow: str = "Workflow"
    unassigned: str = "Unassigned"


AutomationRow = Mapping[str, Any]


def _next_run(row: AutomationRow) -> datetime | None:
    value = row["next_run"]
    return value.replace(tzinfo=UTC) if value is not None and value.tzinfo is None else value


def is_one_off(triggers: Sequence[Mapping[str, Any]]) -> bool:
    match triggers:
        case [{"kind": "schedule", "schedule": {"repeat": {"once": _}}}]:
            return True
    return False


def _state(row: AutomationRow, running: bool, now: datetime) -> str:
    if running:
        return "running"
    if row["routine_state"] != "active":
        return "paused"
    triggers = row["triggers"]
    next_run = _next_run(row)
    if next_run is None and any(trigger.get("kind") != "schedule" for trigger in triggers):
        return "listening"
    if next_run is None and is_one_off(triggers) and row["has_completed_occurrence"]:
        return "completed"
    if not triggers or (next_run is None and all("once" in trigger["schedule"]["repeat"] for trigger in triggers)):
        return "on_demand"
    if next_run is not None and next_run <= now:
        return "due"
    return "scheduled"


def _matches(row: AutomationRow, request: AutomationListRequest) -> bool:
    if request.agent and row["agent_id"] != request.agent:
        return False
    if request.assignee and request.assignee not in (row["assignee"] or request.owner).lower():
        return False
    tags = row["tags"] or ()
    if request.tag and not any(tag.lower() == request.tag for tag in tags):
        return False
    if request.trigger:
        kinds = {trigger.get("kind") for trigger in row["triggers"]}
        if (bool(kinds) if request.trigger == "none" else request.trigger not in kinds):
            return False
    if request.search:
        ref = f"AUTO-{row['number']}" if row["number"] is not None else row["id"]
        text = f"{ref} {row['title']} {row['description']} {row['id']} {' '.join(tags)}"
        return request.search in text.lower()
    return True


def _sorted(rows: list[AutomationRow], request: AutomationListRequest) -> list[AutomationRow]:
    latest = datetime.max.replace(tzinfo=UTC)
    # The store supplies recency order as the stable tiebreaker.
    rows.sort(key=lambda row: (row["routine_state"] != "active", _next_run(row) or latest))
    key = request.sort.lstrip("-")
    if not key:
        return rows

    def value(row: AutomationRow) -> Any:
        match key:
            case "title":
                return task_list_text_order(row["title"])
            case "priority":
                return {"high": 0, "normal": 1, "low": 2}.get(row["priority"], 3)
            case "assignee":
                name = task_list_assignee(
                    row, missing_agent=request.missing_agent, missing_team=request.missing_team,
                    workflow=request.workflow, unassigned=request.unassigned,
                ).strip()
                return task_list_text_order(name) if name else None
            case _:
                return _next_run(row)

    present, missing = [], []
    for row in rows:
        item = value(row)
        if item is None:
            missing.append(row)
        else:
            present.append((item, row))
    present.sort(key=lambda pair: pair[0], reverse=request.sort.startswith("-"))
    return [row for _, row in present] + missing


def automation_window(
    rows: Sequence[AutomationRow], run_states: Mapping[str, set[str]], request: AutomationListRequest,
) -> tuple[list[str], dict[str, Any]]:
    result: dict[str, Any] = {}
    if request.computer_id:
        unplaced = [row for row in rows if not row["computer"] and row["effective_computer"] in (None, request.computer_id)]
        items, position = task_list_window(unplaced, request.unplaced_page, 10)
        result["unplaced"] = {**position, "tasks": [{"id": row["id"], "title": row["title"]} for row in items]}
        rows = [row for row in rows if row["effective_computer"] == request.computer_id]

    tags: dict[str, str] = {}
    counts = dict.fromkeys(AUTOMATION_LIST_STATES, 0)
    states: dict[str, str] = {}
    matches = []
    has_live_runs = False
    for row in rows:
        statuses = run_states.get(row["id"], set())
        has_live_runs |= bool(statuses.intersection(("assigned", "queued", "running")))
        for tag in row["tags"] or ():
            tags.setdefault(tag.lower(), tag)
        if _matches(row, request):
            state = _state(row, bool(statuses.intersection(RUNNING_OCCURRENCE_STATUSES)), request.now)
            counts[state] += 1
            if not request.state or request.state == state:
                matches.append(row)
                states[row["id"]] = state

    visible, page = task_list_window(_sorted(matches, request), request.page, 25)
    ids = [row["id"] for row in visible]
    result.update(
        automationCount=len(rows), counts=counts, tags=list(tags.values()), page=page,
        states={key: states[key] for key in ids}, hasLiveRuns=has_live_runs,
    )
    return ids, result
