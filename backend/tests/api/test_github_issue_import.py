"""Importing a GitHub repository's issues as tasks."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import httpx
import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.tasks import github_issues

from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer
from user_ids import user_id

ALICE = user_id("alice")


def _issue(number: int, **fields) -> dict:
    return {
        "number": number,
        "title": f"Issue {number}",
        "body": f"Body of {number}",
        "html_url": f"javascript:alert({number})",
        "state": "open",
        "labels": [{"name": "bug"}, {"name": "a,b"}],
        "user": {"login": "octocat"},
        "comments": 2,
        "created_at": "2026-11-01T10:00:00Z",
        "updated_at": "2026-11-02T10:00:00Z",
        **fields,
    }


class FakeGitHub:
    """An ``api.github.com`` stand-in that records what it was asked."""

    def __init__(self, issues: list[dict]):
        self.issues = {issue["number"]: issue for issue in issues}
        self.requests: list[httpx.Request] = []
        self.status: int | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.url.host == "api.github.com"
        if self.status:
            return httpx.Response(self.status, json={}, headers={"x-ratelimit-remaining": "0"})
        parts = request.url.path.strip("/").split("/")
        if parts[:3] != ["repos", "octo", "hello"]:
            return httpx.Response(404, json={"message": "Not Found"})
        if len(parts) == 4:
            return httpx.Response(200, json=list(self.issues.values()), headers={"link": '<x>; rel="next"'})
        issue = self.issues.get(int(parts[4]))
        return httpx.Response(200, json=issue) if issue else httpx.Response(404, json={})


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub([_issue(1), _issue(2), _issue(3, pull_request={"url": "x"})])
    monkeypatch.setattr(github_issues, "transport", httpx.MockTransport(fake.handler))
    return fake


@pytest.fixture
def context(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice_github", "github-computer")
    lead = _agent(client, app, node, "Lead", "codex")
    _login_alice(client)
    created = client.post("/api/v1/projects", json={
        "name": "Hello", "daemonNodeId": node["id"], "leadAgentId": lead["id"],
        "members": [dict(agentId=lead["id"], role="implementer", responsibilities="Deliver", enabled=True)],
    })
    assert created.status_code == 201, created.text
    return app, client, created.json()["project"]


def test_preview_lists_issues_without_pull_requests(context, github):
    _app, client, project = context
    response = client.post("/api/v1/tasks/github/issues", json={
        "repository": "https://github.com/octo/hello/issues", "projectId": project["id"],
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["repository"]["fullName"] == "octo/hello"
    assert body["hasMore"] is True
    assert [issue["number"] for issue in body["issues"]] == [1, 2]
    assert body["issues"][0]["url"] == "https://github.com/octo/hello/issues/1"
    assert body["issues"][0]["importedTaskId"] is None
    assert "body" not in body["issues"][0]
    assert github.requests[0].url.params["state"] == "open"


def test_import_creates_backlog_tasks_in_the_project_and_skips_repeats(context, github):
    _app, client, project = context
    response = client.post("/api/v1/tasks/github/import", json={
        "repository": "octo/hello", "projectId": project["id"], "numbers": [1, 3, 9],
    })
    assert response.status_code == 201, response.text
    body = response.json()
    [task] = body["created"]
    assert task["title"] == "Issue 1"
    assert task["status"] == "backlog"
    assert task["projectId"] == project["id"]
    assert task["tags"] == ["bug"]
    assert task["externalSource"] == {
        "provider": "github", "ref": "github:octo/hello#1", "repository": "octo/hello",
        "number": 1, "url": "https://github.com/octo/hello/issues/1",
    }
    assert task["description"].startswith("Body of 1")
    assert "[octo/hello#1](https://github.com/octo/hello/issues/1)" in task["description"]
    assert body["skipped"] == [{"number": 3, "reason": "pull_request"}]
    assert body["failed"] == [{"number": 9, "reason": "github_not_found"}]

    again = client.post("/api/v1/tasks/github/import", json={
        "repository": "Octo/Hello", "projectId": project["id"], "numbers": [1],
    }).json()
    assert again["created"] == []
    assert again["skipped"] == [{"number": 1, "reason": "already_imported", "taskId": task["id"]}]

    preview = client.post("/api/v1/tasks/github/issues", json={
        "repository": "octo/hello", "projectId": project["id"],
    }).json()
    assert preview["issues"][0]["importedTaskId"] == task["id"]


def test_import_without_project_lands_in_intake_separately(context, github):
    _app, client, project = context
    assert client.post("/api/v1/tasks/github/import", json={
        "repository": "octo/hello", "projectId": project["id"], "numbers": [1],
    }).status_code == 201
    body = client.post("/api/v1/tasks/github/import", json={
        "repository": "octo/hello", "numbers": [1],
    }).json()
    [task] = body["created"]
    assert not task.get("projectId")
    assert task["ownerUserId"] == ALICE


def test_deleted_import_can_be_imported_again(context, github):
    _app, client, project = context
    payload = {"repository": "octo/hello", "projectId": project["id"], "numbers": [2]}
    [task] = client.post("/api/v1/tasks/github/import", json=payload).json()["created"]
    assert client.delete(f"/api/v1/tasks/{task['id']}").status_code == 200
    assert len(client.post("/api/v1/tasks/github/import", json=payload).json()["created"]) == 1


def test_rate_limit_stops_the_import(context, github):
    _app, client, project = context
    github.status = 403
    body = client.post("/api/v1/tasks/github/import", json={
        "repository": "octo/hello", "projectId": project["id"], "numbers": [1, 2],
    }).json()
    assert body["failed"] == [
        {"number": 1, "reason": "github_rate_limited"},
        {"number": 2, "reason": "github_rate_limited"},
    ]
    assert len(github.requests) == 1
    preview = client.post("/api/v1/tasks/github/issues", json={"repository": "octo/hello"})
    assert preview.status_code == 429
    assert preview.json()["detail"] == "github_rate_limited"


def test_token_is_sent_to_github_and_not_kept(context, github):
    app, client, project = context
    client.post("/api/v1/tasks/github/import", json={
        "repository": "octo/hello", "projectId": project["id"], "numbers": [1], "token": "ghp_secret123",
    })
    assert github.requests[0].headers["authorization"] == "Bearer ghp_secret123"
    [task] = app.state.task_store.find_tasks_by_external_refs(["github:octo/hello#1"])
    assert "ghp_secret123" not in json.dumps(task)


@pytest.mark.parametrize(("payload", "detail"), [
    ({"repository": ""}, "github_repository_required"),
    ({"repository": "https://evil.example/octo/hello"}, "github_repository_invalid"),
    ({"repository": "octo/../x"}, "github_repository_invalid"),
    ({"repository": "octo/hello", "token": "has space"}, "github_token_invalid"),
    ({"repository": "octo/hello", "numbers": []}, "github_issue_numbers_required"),
    ({"repository": "octo/hello", "numbers": [0]}, "github_issue_numbers_invalid"),
    ({"repository": "octo/hello", "numbers": list(range(1, 52))}, "github_import_too_large"),
])
def test_import_rejects_bad_requests(context, github, payload, detail):
    _app, client, _project = context
    response = client.post("/api/v1/tasks/github/import", json=payload)
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == detail
    assert github.requests == []


def test_import_into_someone_elses_project_is_refused(context, github):
    _app, client, _project = context
    response = client.post("/api/v1/tasks/github/import", json={
        "repository": "octo/hello", "projectId": "00000000-0000-0000-0000-000000000000", "numbers": [1],
    })
    assert response.status_code in (403, 404)
    assert github.requests == []


def test_post_tasks_cannot_forge_an_external_source(context):
    _app, client, _project = context
    task = client.post("/api/v1/tasks", json={
        "title": "Forged", "externalSource": {"ref": "github:octo/hello#1"},
    }).json()
    assert "externalSource" not in task


def test_import_preserves_a_long_issue_body(context, github):
    _app, client, _project = context
    body = "Long issue content. " * 1500 + "Final acceptance criterion."
    github.issues[1]["body"] = body
    response = client.post("/api/v1/tasks/github/import", json={
        "repository": "octo/hello", "numbers": [1],
    })
    assert response.status_code == 201, response.text
    assert response.json()["created"][0]["description"].startswith(body)


@pytest.mark.parametrize("into_project", [True, False])
def test_concurrent_imports_create_only_one_task(context, github, monkeypatch, into_project):
    app, client, project = context
    barrier = Barrier(2)
    original = github.handler

    def handler(request):
        # Both requests have completed their preview-time duplicate check.
        barrier.wait(timeout=10)
        return original(request)

    monkeypatch.setattr(github_issues, "transport", httpx.MockTransport(handler))
    payload = {"repository": "octo/hello", "numbers": [1]}
    if into_project:
        payload["projectId"] = project["id"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post("/api/v1/tasks/github/import", json=payload), range(2)))
    assert [response.status_code for response in responses] == [201, 201]
    outcomes = [response.json() for response in responses]
    created = [task for outcome in outcomes for task in outcome["created"]]
    skipped = [item for outcome in outcomes for item in outcome["skipped"]]
    assert len(created) == 1
    assert skipped == [{"number": 1, "reason": "already_imported", "taskId": created[0]["id"]}]
    assert len(app.state.task_store.find_tasks_by_external_refs(["github:octo/hello#1"])) == 1
