"""Reading a GitHub repository's issues over the REST API.

The import only ever reads, and only from ``api.github.com``: the host is
fixed, redirects are not followed, and a repository is named by validated
``owner``/``name`` segments, so a request can never be pointed elsewhere.
A token is optional (public repositories read without one, within GitHub's
anonymous rate limit); it rides only in this request's ``Authorization``
header and is never stored or logged.

Pull requests share the issues endpoint; they are flagged so the import can
leave them out.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

API_ROOT = "https://api.github.com"
API_VERSION = "2022-11-28"
TIMEOUT_SECONDS = 15.0
PAGE_SIZE = 50
MAX_PAGE = 100
ISSUE_STATES = ("open", "closed", "all")
MAX_TOKEN_CHARS = 255
MAX_LABEL_FILTER_CHARS = 200

_OWNER = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_NAME = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_TOKEN = re.compile(r"^[\x21-\x7e]+$")

# Tests swap in an ``httpx.MockTransport``; production uses the default.
transport: httpx.BaseTransport | None = None


class GitHubError(Exception):
    """A GitHub read that failed; ``code`` is the API detail, ``status`` its HTTP status."""

    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class Repository:
    owner: str
    name: str

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"


def parse_repository(value: Any) -> Repository:
    """``owner/name`` or a ``https://github.com/owner/name[...]`` URL."""
    if not isinstance(value, str) or not value.strip():
        raise GitHubError(400, "github_repository_required")
    text = value.strip()
    if "://" in text or text.startswith("github.com/"):
        parts = urlsplit(text if "://" in text else f"https://{text}")
        if parts.scheme != "https" or (parts.hostname or "").lower() not in ("github.com", "www.github.com"):
            raise GitHubError(400, "github_repository_invalid")
        text = parts.path
    segments = [segment for segment in text.strip("/").split("/") if segment]
    if len(segments) < 2:
        raise GitHubError(400, "github_repository_invalid")
    owner, name = segments[0], segments[1].removesuffix(".git")
    if not _OWNER.match(owner) or not _NAME.match(name) or name in (".", ".."):
        raise GitHubError(400, "github_repository_invalid")
    return Repository(owner, name)


def parse_token(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value) > MAX_TOKEN_CHARS or not _TOKEN.match(value.strip()):
        raise GitHubError(400, "github_token_invalid")
    return value.strip()


@dataclass(frozen=True)
class IssuePage:
    issues: list[dict[str, Any]]
    has_more: bool


class GitHubIssueClient:
    def __init__(self, token: str | None = None):
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "relay-issue-import",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.Client(
            base_url=API_ROOT,
            headers=headers,
            timeout=TIMEOUT_SECONDS,
            follow_redirects=False,
            transport=transport,
        )

    def __enter__(self) -> GitHubIssueClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self._client.close()

    def list_issues(
        self, repo: Repository, *, state: str = "open", labels: str = "", page: int = 1
    ) -> IssuePage:
        params: dict[str, Any] = {
            "state": state, "per_page": PAGE_SIZE, "page": page,
            "sort": "created", "direction": "desc",
        }
        if labels:
            params["labels"] = labels
        response = self._get(f"/repos/{repo.owner}/{repo.name}/issues", params)
        payload = response.json()
        if not isinstance(payload, list):
            raise GitHubError(502, "github_unexpected_response")
        issues = [issue for item in payload if (issue := normalize_issue(item, repo))]
        return IssuePage(issues, 'rel="next"' in response.headers.get("link", ""))

    def get_issue(self, repo: Repository, number: int) -> dict[str, Any]:
        response = self._get(f"/repos/{repo.owner}/{repo.name}/issues/{number}", None)
        issue = normalize_issue(response.json(), repo)
        if issue is None:
            raise GitHubError(502, "github_unexpected_response")
        return issue

    def _get(self, path: str, params: dict[str, Any] | None) -> httpx.Response:
        try:
            response = self._client.get(path, params=params)
        except httpx.TimeoutException as error:
            raise GitHubError(504, "github_timeout") from error
        except httpx.HTTPError as error:
            raise GitHubError(502, "github_unreachable") from error
        if response.status_code == 200:
            return response
        raise _error_for(response)


def _error_for(response: httpx.Response) -> GitHubError:
    status = response.status_code
    if status in (403, 429) and response.headers.get("x-ratelimit-remaining") == "0":
        return GitHubError(429, "github_rate_limited")
    if status == 401:
        # Never answer 401: the web client reads that as its own sign-out.
        return GitHubError(422, "github_token_rejected")
    if status == 404:
        return GitHubError(404, "github_not_found")
    if status in (301, 302, 307, 308):
        return GitHubError(409, "github_repository_moved")
    if status == 410:
        return GitHubError(404, "github_issues_disabled")
    if status == 403:
        return GitHubError(403, "github_forbidden")
    return GitHubError(502, "github_unavailable")


def issue_url(repo: Repository, number: int) -> str:
    return f"https://github.com/{repo.owner}/{repo.name}/issues/{number}"


def normalize_issue(item: Any, repo: Repository) -> dict[str, Any] | None:
    """The fields the import reads, or ``None`` for a malformed record.

    The link is built from the validated repository rather than read from
    ``html_url``, so a rendered link can only ever point at github.com.
    """
    if not isinstance(item, dict):
        return None
    number, title = item.get("number"), item.get("title")
    if not isinstance(number, int) or number < 1 or not isinstance(title, str):
        return None
    raw_user = item.get("user")
    user: dict[str, Any] = raw_user if isinstance(raw_user, dict) else {}
    return {
        "number": number,
        "title": title,
        "body": item.get("body") if isinstance(item.get("body"), str) else "",
        "url": issue_url(repo, number),
        "state": item.get("state") if item.get("state") in ("open", "closed") else "open",
        "labels": [
            label["name"]
            for label in item.get("labels") or []
            if isinstance(label, dict) and isinstance(label.get("name"), str)
        ],
        "author": user.get("login") if isinstance(user.get("login"), str) else None,
        "comments": item.get("comments") if isinstance(item.get("comments"), int) else 0,
        "createdAt": item.get("created_at"),
        "updatedAt": item.get("updated_at"),
        "isPullRequest": "pull_request" in item,
    }
