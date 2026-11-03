"""Importing GitHub issues as tasks: a preview, then the import itself.

Both routes read public repositories anonymously. Tokens and saved account
connections are not used. ``projectId`` names the destination backlog; without
it, issues land in the caller's intake.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...security.actor import Actor
from ...tasks.github_import import (
    MAX_IMPORT_ISSUES,
    ImportDestination,
    ImportRequest,
    import_issues,
    imported_tasks,
    issue_ref,
)
from ...tasks.github_issues import (
    ISSUE_STATES,
    MAX_LABEL_FILTER_CHARS,
    MAX_PAGE,
    GitHubError,
    GitHubIssueClient,
    Repository,
    parse_repository,
)
from ..actors import request_actor
from ..bodies import JsonBodyDep, string_field
from ..deps import AppContext, AppContextDep
from ..projects.access import project_for_owner, project_session_fields
from .payloads import public_task, request_reader, task_request_errors

router = APIRouter()


@router.post("/tasks/github/issues")
def preview_github_issues(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = _request_body
    repo = _public_repository(body)
    destination = _destination(ctx, actor, body)
    state = string_field(body, "state") or "open"
    if state not in ISSUE_STATES:
        raise HTTPException(400, "github_state_invalid")
    labels = string_field(body, "labels")
    if len(labels) > MAX_LABEL_FILTER_CHARS:
        raise HTTPException(400, "github_labels_invalid")
    page = _page(body.get("page"))
    try:
        with GitHubIssueClient() as client:
            client.require_public_repository(repo)
            listing = client.list_issues(repo, state=state, labels=labels, page=page)
    except GitHubError as error:
        raise HTTPException(error.status, error.code) from error
    issues = [issue for issue in listing.issues if not issue["isPullRequest"]]
    existing = imported_tasks(
        ctx.task_store, [issue_ref(repo, issue["number"]) for issue in issues], destination
    )
    return {
        "repository": {"owner": repo.owner, "name": repo.name, "fullName": repo.full_name},
        "page": page,
        "hasMore": listing.has_more,
        "issues": [
            {
                **{key: value for key, value in issue.items() if key not in ("body", "isPullRequest")},
                "importedTaskId": (existing.get(issue_ref(repo, issue["number"])) or {}).get("id"),
            }
            for issue in issues
        ],
    }


@router.post("/tasks/github/import", status_code=201)
def import_github_issues(
    request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    body = _request_body
    repo = _public_repository(body)
    destination = _destination(ctx, actor, body)
    numbers = _issue_numbers(body.get("numbers"))
    with task_request_errors(), GitHubIssueClient() as client:
        try:
            client.require_public_repository(repo)
        except GitHubError as error:
            raise HTTPException(error.status, error.code) from error
        result = import_issues(
            ctx,
            actor,
            client,
            ImportRequest(
                repo=repo,
                numbers=numbers,
                destination=destination,
                reader=request_reader(),
                project_session_fields=lambda selected: project_session_fields(ctx, selected),
            ),
        )
    return {
        "created": [public_task(task) for task in result.created],
        "skipped": result.skipped,
        "failed": result.failed,
    }


def _public_repository(body: dict[str, Any]) -> Repository:
    if "token" in body:
        raise HTTPException(400, "github_public_repositories_only")
    try:
        return parse_repository(body.get("repository"))
    except GitHubError as error:
        raise HTTPException(error.status, error.code) from error


def _destination(ctx: AppContext, actor: Actor, body: dict[str, Any]) -> ImportDestination:
    owner = actor["userId"]
    project_id = string_field(body, "projectId") or None
    project = project_for_owner(ctx, project_id, owner, require_enabled=True)
    return ImportDestination(owner_user_id=owner, project=project)


def _page(value: Any) -> int:
    if value is None:
        return 1
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_PAGE:
        raise HTTPException(400, "github_page_invalid")
    return value


def _issue_numbers(value: Any) -> list[int]:
    if not isinstance(value, list) or not value:
        raise HTTPException(400, "github_issue_numbers_required")
    numbers: list[int] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int) or item < 1:
            raise HTTPException(400, "github_issue_numbers_invalid")
        if item not in numbers:
            numbers.append(item)
    if len(numbers) > MAX_IMPORT_ISSUES:
        raise HTTPException(400, "github_import_too_large")
    return numbers
