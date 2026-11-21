"""SQL windows and collection facets for the global Issues directory."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import Integer, Text, and_, case, cast, false, func, or_, select, true
from sqlalchemy.sql.elements import ColumnElement

from ...core.issue_listing import ISSUE_LANES, ISSUE_PRIORITIES, ISSUE_STATUSES, IssueListRequest
from ..tables.projects import projects


def supports_sql_window(request: IssueListRequest) -> bool:
    # These comparisons use Python's Unicode normalization and display
    # labels. Keep their existing semantics across database collations.
    return (
        not request.workspace_board
        and not (request.query or request.tag or request.assignee or request.needs_assignee_names)
        and request.sort.lstrip("-") not in ("title", "project")
    )


def _scoped_issues(tasks: Any, request: IssueListRequest) -> Any:
    snapshot = tasks.c.snapshot
    visible_project: ColumnElement[bool] = projects.c.archived_at.is_(None)
    if request.project_id:
        visible_project = or_(visible_project, cast(projects.c.id, Text) == request.project_id)
    return select(
        tasks.c.id, tasks.c.project_id, tasks.c.status, tasks.c.priority,
        tasks.c.due_date.label("due"), tasks.c.created_at.label("created"), tasks.c.updated_at.label("updated"),
        tasks.c.assignee_user_id, tasks.c.assigned_agent, tasks.c.assigned_agent_id, tasks.c.assigned_team_id,
        snapshot["computerId"].as_string().label("computer"),
        snapshot["sourceRoutineId"].as_string().label("source"),
        snapshot["workflowStage"].as_string().label("stage"),
        snapshot["tags"].label("tags"),
    ).select_from(tasks.outerjoin(projects, projects.c.id == tasks.c.project_id)).where(
        tasks.c.owner_user_id == request.owner, tasks.c.deleted_at.is_(None), tasks.c.is_routine.is_(False),
        or_(tasks.c.project_id.is_(None), and_(projects.c.id.is_not(None), visible_project)),
    ).subquery()


def _matches(rows: Any, request: IssueListRequest) -> Any:
    filters = []
    if request.project_id:
        filters.append(cast(rows.project_id, Text) == request.project_id)
    if request.priority:
        filters.append(rows.priority == request.priority)
    if request.source:
        filters.append(func.coalesce(rows.source, "") != "" if request.source == "routine" else
                       func.coalesce(rows.source, "") == "")
    if request.agent:
        filters.append(cast(rows.assigned_agent_id, Text) == request.agent)
    if request.team:
        filters.append(cast(rows.assigned_team_id, Text) == request.team)
    if request.assignment:
        has_assignment = or_(
            func.coalesce(cast(rows.assigned_agent_id, Text), "") != "",
            func.coalesce(cast(rows.assigned_team_id, Text), "") != "",
            func.coalesce(rows.assigned_agent, "") != "",
        )
        filters.append(has_assignment if request.assignment == "assigned" else ~has_assignment)
    open_issue = rows.status.not_in(("done", "cancelled"))
    match request.due:
        case "overdue":
            filters.extend((rows.due < request.today, open_issue))
        case "today":
            filters.append(rows.due == request.today)
        case "next_week":
            filters.extend((rows.due >= request.today, rows.due < request.today + timedelta(days=7), open_issue))
        case "unscheduled":
            filters.append(rows.due.is_(None))
    return and_(true(), *filters)


def _queues(rows: Any, request: IssueListRequest) -> dict[str, Any]:
    opened = rows.status.not_in(("done", "cancelled"))
    return {
        "needs_me": and_(rows.status.in_(("review", "waiting_for_human")),
                         func.coalesce(func.nullif(cast(rows.assignee_user_id, Text), ""), request.owner) == request.owner),
        "untriaged": and_(opened, rows.project_id.is_(None), func.coalesce(rows.computer, "") == "",
                         func.coalesce(rows.source, "") == ""),
        "blocked": rows.status == "blocked",
        "running": rows.status == "running",
        "overdue": and_(opened, rows.due < request.today),
        "open": opened,
        "done": rows.status == "done",
        "cancelled": rows.status == "cancelled",
    }


def _order(rows: Any, sort: str) -> list[Any]:
    priority = case(ISSUE_PRIORITIES, value=rows.priority, else_=len(ISSUE_PRIORITIES))
    default_order = [priority, func.coalesce(rows.due, date.max), rows.created, rows.id]
    key = sort.lstrip("-")
    if not key:
        return default_order
    if key == "priority":
        value = priority
    elif key == "status":
        status_order = {status: index for index, status in enumerate(ISSUE_STATUSES)}
        value = case(status_order, value=rows.status, else_=len(ISSUE_STATUSES))
    else:
        value = rows[key]
    return [(value.desc() if sort.startswith("-") else value.asc()).nulls_last(), *default_order]


def _tags(conn: Any, scope: Any) -> list[str]:
    rows = scope.c
    position: ColumnElement[Any]
    if conn.dialect.name == "postgresql":
        tags = func.jsonb_array_elements_text(
            case((func.jsonb_typeof(rows.tags) == "array", rows.tags), else_=None),
        ).table_valued("value", with_ordinality="position").render_derived()
        position = tags.c.position
    else:
        tags = func.json_each(rows.tags).table_valued("value", "key")
        position = cast(tags.c.key, Integer)
    newest = (
        select(tags.c.value, rows.updated, rows.id, position.label("position"),
               func.row_number().over(
                   partition_by=tags.c.value, order_by=(rows.updated.desc(), rows.id.desc(), position),
               ).label("occurrence"))
        .select_from(scope.join(tags, true()))
        .where(tags.c.value.is_not(None))
        .subquery()
    )
    distinct: dict[str, str] = {}
    statement = select(newest.c.value).where(newest.c.occurrence == 1).order_by(
        newest.c.updated.desc(), newest.c.id.desc(), newest.c.position,
    )
    for tag in conn.scalars(statement):
        distinct.setdefault(tag.lower(), tag)
    return list(distinct.values())


def _page(total: int, requested: int, size: int) -> dict[str, int]:
    return {"page": min(requested, max(1, (total + size - 1) // size)), "total": total}


def _board_window(
    conn: Any, scope: Any, filters: Any, order: list[Any], request: IssueListRequest,
) -> tuple[list[str], dict[str, dict[str, int]]]:
    rows = scope.c
    legacy = case((rows.status.in_(("blocked", "waiting_for_human")), "running"), else_=rows.status)
    stage = func.coalesce(func.nullif(rows.stage, ""), legacy)
    totals_query = select(stage, func.count()).select_from(scope).where(
        filters, stage.in_(ISSUE_LANES),
    ).group_by(stage)
    totals = {lane: count for lane, count in conn.execute(totals_query)}
    size = 10
    pages = {lane: _page(totals.get(lane, 0), request.lanes.get(lane, 1), size) for lane in ISSUE_LANES}
    ranked = select(
        rows.id, stage.label("lane"),
        func.row_number().over(partition_by=stage, order_by=order).label("position"),
    ).where(filters, stage.in_(ISSUE_LANES)).subquery()
    starts = {lane: (page["page"] - 1) * size for lane, page in pages.items() if page["total"]}
    if not starts:
        return [], pages
    start = case(starts, value=ranked.c.lane)
    lane_order = case({lane: index for index, lane in enumerate(ISSUE_LANES)}, value=ranked.c.lane)
    query = select(ranked.c.id).where(
        ranked.c.position > start, ranked.c.position <= start + size,
    ).order_by(lane_order, ranked.c.position)
    return list(conn.scalars(query)), pages


def global_issue_window(conn: Any, tasks: Any, request: IssueListRequest) -> tuple[list[str], dict[str, Any]]:
    scope = _scoped_issues(tasks, request)
    rows = scope.c
    matches = _matches(rows, request)
    queues = _queues(rows, request)
    totals = conn.execute(select(
        func.count().label("issue_count"),
        *(func.count().filter(matches, predicate).label(key) for key, predicate in queues.items()),
    ).select_from(scope)).mappings().one()
    metadata = {
        "issueCount": totals["issue_count"], "counts": {key: totals[key] for key in queues},
        "tags": _tags(conn, scope) if totals["issue_count"] else [],
    }
    key = request.queue
    filtered = and_(matches, queues.get(key, false()))
    order = _order(rows, request.sort)
    if request.layout == "board":
        ids, lanes = _board_window(conn, scope, filtered, order, request)
        return ids, {**metadata, "lanes": lanes}

    size = 50
    page = _page(totals.get(key, 0), request.page, size)
    if not page["total"]:
        return [], {**metadata, "page": page, "groupTotals": {}}
    if request.group == "project":
        group = func.coalesce(cast(rows.project_id, Text), "none")
    elif request.group == "status":
        group = rows.status
    else:
        group = func.coalesce("none", rows.status)
    selected = select(rows.id, group.label("group_key"), func.count().over(partition_by=group).label("total")).where(
        filtered,
    ).order_by(*order).offset((page["page"] - 1) * size).limit(size)
    window = conn.execute(selected).all()
    return [row.id for row in window], {
        **metadata, "page": page, "groupTotals": {row.group_key: row.total for row in window},
    }
