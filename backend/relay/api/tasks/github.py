"""Importing GitHub issues as tasks: a preview, then the import itself.

Both routes take the repository and an optional ``token`` in the body (never
the URL, so no access log keeps one); the token is used for this request's
GitHub reads only and is never stored. ``projectId`` names the destination
backlog; without it, issues land in the caller's intake.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ...security.actor import Actor
from ...security.request_auth import require_user_session, user_session_token_from_request
from ..accounts.github import github_connection_errors
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
    parse_token,
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
    repo, token = _repository_and_token(body)
    destination = _destination(ctx, actor, body)
    state = string_field(body, "state") or "open"
    if state not in ISSUE_STATES:
        raise HTTPException(400, "github_state_invalid")
    labels = string_field(body, "labels")
    if len(labels) > MAX_LABEL_FILTER_CHARS:
        raise HTTPException(400, "github_labels_invalid")
    page = _page(body.get("page"))
    token = _connected_token(request, ctx, actor, token)
    try:
        with GitHubIssueClient(token) as client:
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
    repo, token = _repository_and_token(body)
    destination = _destination(ctx, actor, body)
    numbers = _issue_numbers(body.get("numbers"))
    token = _connected_token(request, ctx, actor, token)
    with task_request_errors(), GitHubIssueClient(token) as client:
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


def _connected_token(request: Request, ctx: AppContext, actor: Actor, token: str | None) -> str | None:
    if token or not ctx.github_connection or not user_session_token_from_request(request):
        return token
    account = require_user_session(request, ctx.auth_store)
    # A chat-service actor may name a different user; it must never borrow a
    # browser account's saved credential.
    if account["id"] != actor["account"]["id"]:
        return None
    with github_connection_errors():
        return ctx.github_connection.token_for(account["id"])


def _repository_and_token(body: dict[str, Any]) -> tuple[Repository, str | None]:
    try:
        return parse_repository(body.get("repository")), parse_token(body.get("token"))
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
