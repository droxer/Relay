"""Importing GitHub issues as tasks.

An imported issue becomes an ordinary backlog task — created through
``create_task`` so every admission rule applies — that remembers its source
as ``externalSource`` (``ref``, ``repository``, ``number``, ``url``). The
import is one-way and one-shot: nothing is written back to GitHub, and a task
does not follow later edits to its issue.

An issue lands in one destination (a project's backlog, or the importer's
intake when no project is named) at most once: the same ``ref`` already live
there is skipped, so re-running an import only brings in what is new. The
issue is read from GitHub again at import time; the preview the person saw is
never trusted for content.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from ..core.task_tags import MAX_TAGS, normalize_tag
from ..persistence.task.rules import TaskAlreadyImportedError
from ..security.actor import Actor
from .creation import TaskCreateRequest, create_task
from .github_issues import GitHubError, GitHubIssueClient, Repository
from .requests import TaskRequestReader

PROVIDER = "github"
MAX_IMPORT_ISSUES = 50
# A failure that will fail every later issue too, so the import stops.
_FATAL_CODES = frozenset({"github_rate_limited", "github_token_rejected", "github_forbidden", "github_unreachable"})


def issue_ref(repo: Repository, number: int) -> str:
    """The stable key of one issue; GitHub names are case-insensitive."""
    return f"{PROVIDER}:{repo.full_name.lower()}#{number}"


@dataclass(frozen=True)
class ImportDestination:
    owner_user_id: str
    project: dict[str, Any] | None

    def holds(self, task: dict[str, Any]) -> bool:
        if self.project:
            return task.get("projectId") == self.project["id"]
        return not task.get("projectId") and task.get("ownerUserId") == self.owner_user_id


def imported_tasks(
    task_store: Any, refs: list[str], destination: ImportDestination
) -> dict[str, dict[str, Any]]:
    """The live task each ``ref`` already became in ``destination``."""
    return {
        (task.get("externalSource") or {})["ref"]: task
        for task in task_store.find_tasks_by_external_refs(refs)
        if destination.holds(task)
    }


def task_fields(repo: Repository, issue: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """The create body and ``externalSource`` one issue becomes."""
    reference = f"{repo.full_name}#{issue['number']}"
    body = (issue.get("body") or "").strip()
    footer = f"Imported from GitHub issue [{reference}]({issue['url']})."
    fields: dict[str, Any] = {
        "title": issue["title"].strip() or reference,
        "description": f"{body}\n\n---\n{footer}" if body else footer,
    }
    if tags := _label_tags(issue.get("labels") or []):
        fields["tags"] = tags
    source = {
        "provider": PROVIDER,
        "ref": issue_ref(repo, issue["number"]),
        "repository": repo.full_name,
        "number": issue["number"],
        "url": issue["url"],
    }
    return fields, source


def _label_tags(labels: list[str]) -> list[str]:
    """Labels that are valid tags, first spelling wins; the rest are dropped."""
    tags: list[str] = []
    seen: set[str] = set()
    for label in labels:
        try:
            tag = normalize_tag(label)
        except ValueError:
            continue
        if tag.casefold() not in seen:
            seen.add(tag.casefold())
            tags.append(tag)
    return tags[:MAX_TAGS]


@dataclass
class ImportResult:
    created: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[dict[str, Any]] = field(default_factory=list)
    failed: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class ImportRequest:
    repo: Repository
    numbers: list[int]
    destination: ImportDestination
    reader: TaskRequestReader
    project_session_fields: Callable[[dict[str, Any]], dict[str, Any]]


def import_issues(
    ctx: Any, actor: Actor, client: GitHubIssueClient, request: ImportRequest
) -> ImportResult:
    result = ImportResult()
    refs = {number: issue_ref(request.repo, number) for number in request.numbers}
    existing = imported_tasks(ctx.task_store, list(refs.values()), request.destination)
    pending = list(request.numbers)
    while pending:
        number = pending.pop(0)
        if task := existing.get(refs[number]):
            result.skipped.append({"number": number, "reason": "already_imported", "taskId": task["id"]})
            continue
        try:
            issue = client.get_issue(request.repo, number)
        except GitHubError as error:
            result.failed.append({"number": number, "reason": error.code})
            if error.code in _FATAL_CODES:
                result.failed.extend({"number": rest, "reason": error.code} for rest in pending)
                break
            continue
        if issue["isPullRequest"]:
            result.skipped.append({"number": number, "reason": "pull_request"})
            continue
        try:
            result.created.append(_create(ctx, actor, request, issue))
        except TaskAlreadyImportedError as error:
            result.skipped.append({"number": number, "reason": "already_imported", "taskId": error.task_id})
    logger.info(
        "GitHub issues imported",
        repository=request.repo.full_name,
        project_id=(request.destination.project or {}).get("id"),
        created=len(result.created),
        skipped=len(result.skipped),
        failed=len(result.failed),
    )
    return result


def _create(ctx: Any, actor: Actor, request: ImportRequest, issue: dict[str, Any]) -> dict[str, Any]:
    fields, source = task_fields(request.repo, issue)
    destination = request.destination
    return create_task(
        ctx,
        actor,
        TaskCreateRequest(
            body={**fields, "status": "backlog"},
            reader=request.reader,
            title=fields["title"],
            owner=destination.owner_user_id,
            assignee=destination.owner_user_id,
            project=destination.project,
            project_session_fields=request.project_session_fields,
            external_source=source,
        ),
    )
