"""Cross-project issue queues and paging over collection fields."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from .task_listing import task_list_assignee, task_list_text_order, task_list_window

ISSUE_QUEUES = ("needs_me", "untriaged", "blocked", "running", "overdue", "open", "done", "cancelled")
ISSUE_LANES = ("backlog", "assigned", "queued", "running", "review", "done", "cancelled")
ISSUE_STATUSES = ("backlog", "assigned", "queued", "running", "waiting_for_human", "review", "blocked", "done", "cancelled")
ISSUE_PRIORITIES = {"high": 0, "normal": 1, "low": 2}
ISSUE_SORTS = frozenset({"title", "priority", "status", "assignee", "project", "due", "updated"})
ISSUE_GROUPS = frozenset({"project", "status", "assignee", "none"})


@dataclass(frozen=True)
class IssueListRequest:
    owner: str
    today: date
    layout: str = "list"
    queue: str = "open"
    group: str = "project"
    project_id: str = ""
    computer_id: str = ""
    workspace_board: bool = False
    status: str = ""
    unplaced_page: int = 1
    sort: str = ""
    page: int = 1
    lanes: Mapping[str, int] = field(default_factory=dict)
    query: str = ""
    tag: str = ""
    priority: str = ""
    source: str = ""
    due: str = ""
    agent: str = ""
    team: str = ""
    assignee: str = ""
    assignment: str = ""
    missing_agent: str = "Unavailable agent"
    missing_team: str = "Unavailable team"
    workflow: str = "Workflow"
    unassigned: str = "Unassigned"

    @property
    def needs_assignee_names(self) -> bool:
        return self.sort.lstrip("-") == "assignee" or (self.layout == "list" and self.group == "assignee")


IssueRow = Mapping[str, Any]


def _matches(row: IssueRow, request: IssueListRequest, week_end: date) -> bool:
    if request.project_id and row["project_id"] != request.project_id:
        return False
    if request.priority and row["priority"] != request.priority:
        return False
    if request.source and bool(row["source"]) != (request.source == "routine"):
        return False
    if request.tag and not any(tag.lower() == request.tag for tag in row["tags"] or ()):
        return False
    if request.agent and row["agent_id"] != request.agent:
        return False
    if request.team and row["team_id"] != request.team:
        return False
    if request.assignment and bool(row["agent_id"] or row["team_id"] or row["agent"]) != (request.assignment == "assigned"):
        return False
    if request.assignee and request.assignee not in (row["assignee"] or request.owner).lower():
        return False
    if request.query:
        ref = f"#{row['number']}" if row["number"] is not None else row["id"]
        tags = " ".join(row["tags"] or ())
        text = f"{ref} {row['title']} {row['description']} {row['id']} {tags}"
        if request.query not in text.lower():
            return False
    due = row["due"]
    closed = row["status"] in ("done", "cancelled")
    match request.due:
        case "overdue":
            return bool(due and due < request.today and not closed)
        case "today":
            return due == request.today
        case "next_week":
            return bool(due and request.today <= due < week_end and not closed)
        case "unscheduled":
            return due is None
    return True


def _queues(row: IssueRow, request: IssueListRequest) -> tuple[str, ...]:
    status = row["status"]
    if status in ("done", "cancelled"):
        return (status,)
    queues = ["open"]
    if not (row["project_id"] or row["computer"] or row["source"]):
        queues.append("untriaged")
    if status in ("blocked", "running"):
        queues.append(status)
    if row["due"] and row["due"] < request.today:
        queues.append("overdue")
    if status in ("review", "waiting_for_human") and (row["assignee"] or request.owner) == request.owner:
        queues.append("needs_me")
    return tuple(queues)


def _assignee(row: IssueRow, request: IssueListRequest) -> str:
    return task_list_assignee(
        row, missing_agent=request.missing_agent, missing_team=request.missing_team,
        workflow=request.workflow, unassigned=request.unassigned,
    )


def _queue_order(row: IssueRow) -> tuple[Any, ...]:
    return ISSUE_PRIORITIES.get(row["priority"], len(ISSUE_PRIORITIES)), row["due"] or date.max, row["created"], row["id"]


def _sort_issues(rows: list[IssueRow], request: IssueListRequest) -> list[IssueRow]:
    rows.sort(key=_queue_order)
    sort = request.sort.lstrip("-")
    if not sort:
        return rows

    def value(row: IssueRow) -> Any:
        match sort:
            case "assignee":
                return task_list_text_order(name) if (name := _assignee(row, request).strip()) else None
            case "project":
                return task_list_text_order(row["project_name"] or row["project_id"]) if row["project_id"] else None
            case "title":
                return task_list_text_order(row["title"])
            case "priority":
                return ISSUE_PRIORITIES.get(row["priority"], len(ISSUE_PRIORITIES))
            case "status":
                return ISSUE_STATUSES.index(row["status"]) if row["status"] in ISSUE_STATUSES else len(ISSUE_STATUSES)
            case _:
                return row[sort]

    sortable = []
    missing = []
    for row in rows:
        key = value(row)
        if key is None:
            missing.append(row)
        else:
            sortable.append((key, row))
    sortable.sort(key=lambda entry: entry[0], reverse=request.sort.startswith("-"))
    return [row for _, row in sortable] + missing


def _group(row: IssueRow, request: IssueListRequest) -> str:
    match request.group:
        case "project":
            return row["project_id"] or "none"
        case "status":
            return row["status"]
        case "assignee":
            return _assignee(row, request).strip() or "none"
    return "none"


def _stage(row: IssueRow) -> str:
    return row["stage"] or ("running" if row["status"] in ("blocked", "waiting_for_human") else row["status"])


def _lane_window(rows: list[IssueRow], request: IssueListRequest) -> tuple[list[IssueRow], dict[str, Any]]:
    lanes: dict[str, list[IssueRow]] = {lane: [] for lane in ISSUE_LANES}
    for row in rows:
        stage = _stage(row)
        if stage in lanes:
            lanes[stage].append(row)
    visible = []
    pages = {}
    for lane, lane_rows in lanes.items():
        items, pages[lane] = task_list_window(lane_rows, request.lanes.get(lane, 1), 10)
        visible.extend(items)
    return visible, pages


def workspace_board_window(rows: Sequence[IssueRow], request: IssueListRequest) -> tuple[list[str], dict[str, Any]]:
    metadata: dict[str, Any] = {}
    if request.computer_id:
        # Legacy Tasks still offer explicit placement, even when a recorded
        # Thread already makes them visible on this Computer's board.
        unplaced = [row for row in rows if not row["computer"] and row["effective_computer"] in (None, request.computer_id)]
        items, position = task_list_window(unplaced, request.unplaced_page, 10)
        metadata["unplaced"] = {**position, "tasks": [{"id": row["id"], "title": row["title"]} for row in items]}
        rows = [row for row in rows if row["effective_computer"] == request.computer_id]

    tags: dict[str, str] = {}
    counts = dict.fromkeys(ISSUE_LANES, 0)
    matches = []
    week_end = request.today + timedelta(days=7)
    for row in rows:
        for tag in row["tags"] or ():
            tags.setdefault(tag.lower(), tag)
        if _matches(row, request, week_end):
            stage = _stage(row)
            if stage in counts:
                counts[stage] += 1
            status = stage if request.status in ISSUE_LANES else row["status"]
            if request.layout == "board" or not request.status or status == request.status:
                matches.append(row)

    ordered = _sort_issues(matches, request)
    metadata.update(issueCount=len(rows), sectionCounts=counts, tags=list(tags.values()))
    if request.layout == "board":
        visible, metadata["lanes"] = _lane_window(ordered, request)
    else:
        visible, metadata["page"] = task_list_window(ordered, request.page, 25)
    return [row["id"] for row in visible], metadata


def issue_window(rows: list[IssueRow], request: IssueListRequest) -> tuple[list[str], dict[str, Any]]:
    tags: dict[str, str] = {}
    counts = dict.fromkeys(ISSUE_QUEUES, 0)
    matches = []
    week_end = request.today + timedelta(days=7)
    for row in rows:
        for tag in row["tags"] or ():
            tags.setdefault(tag.lower(), tag)
        if not _matches(row, request, week_end):
            continue
        queues = _queues(row, request)
        for queue in queues:
            counts[queue] += 1
        if request.queue in queues:
            matches.append(row)

    ordered = _sort_issues(matches, request)
    metadata: dict[str, Any] = {"issueCount": len(rows), "counts": counts, "tags": list(tags.values())}
    if request.layout == "board":
        visible, metadata["lanes"] = _lane_window(ordered, request)
    else:
        visible, metadata["page"] = task_list_window(ordered, request.page, 50)
        group_totals = Counter(_group(row, request) for row in ordered)
        metadata["groupTotals"] = {key: group_totals[key] for key in dict.fromkeys(_group(row, request) for row in visible)}
    return [row["id"] for row in visible], metadata
