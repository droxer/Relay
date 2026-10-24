from __future__ import annotations

from collections.abc import Iterator
from tempfile import TemporaryDirectory
from typing import Any

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

from test_project_routes import _agent, _bootstrap, _login_alice, _project, _register_computer


@pytest.fixture
def env(monkeypatch) -> Iterator[dict[str, Any]]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app = create_app(root)
        client = TestClient(app)
        _bootstrap(client)
        node = _register_computer(app, "node_unarchive", "unarchive-machine")
        lead = _agent(client, app, node, "Lead", "codex")
        _login_alice(client)
        yield {"app": app, "client": client, "node": node, "lead": lead}


def _archive(client: TestClient, project: dict) -> dict:
    response = client.post(
        f"/api/v1/projects/{project['id']}/archive?expectedVersion={project['version']}"
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]


def _unarchive(client: TestClient, project: dict, version: int | None = None):
    version = project["version"] if version is None else version
    return client.post(
        f"/api/v1/projects/{project['id']}/unarchive?expectedVersion={version}"
    )


def test_unarchive_reopens_the_project_as_it_stood(env) -> None:
    client = env["client"]
    project = _project(client, env["node"], env["lead"], name="Reopen me")
    archived = _archive(client, project)
    assert archived["archivedAt"] and archived["enabled"] is False

    response = _unarchive(client, archived)

    assert response.status_code == 200, response.text
    reopened = response.json()["project"]
    assert "archivedAt" not in reopened
    assert reopened["enabled"] is True
    assert reopened["version"] == archived["version"] + 1
    assert reopened["members"] == project["members"]
    assert reopened["leadAgentId"] == project["leadAgentId"]
    listed = client.get("/api/v1/projects").json()["projects"]
    assert [item["id"] for item in listed if not item.get("archivedAt")] == [project["id"]]
    events = [event["type"] for event in env["app"].state.project_store.events(project["id"])]
    assert events[-2:] == ["project.archived", "project.unarchived"]
    # Live again: an ordinary edit goes through.
    renamed = client.patch(
        f"/api/v1/projects/{project['id']}",
        json={"name": "Reopened", "expectedVersion": reopened["version"]},
    )
    assert renamed.status_code == 200, renamed.text


def test_unarchive_of_a_live_project_changes_nothing(env) -> None:
    client = env["client"]
    project = _project(client, env["node"], env["lead"])

    response = _unarchive(client, project)

    assert response.status_code == 200, response.text
    assert response.json()["project"]["version"] == project["version"]


def test_unarchive_refuses_a_stale_version(env) -> None:
    client = env["client"]
    archived = _archive(client, _project(client, env["node"], env["lead"]))

    response = _unarchive(client, archived, version=archived["version"] - 1)

    assert response.status_code == 409
    assert response.json()["detail"] == "project_version_conflict"


def test_unarchive_requires_an_expected_version(env) -> None:
    client = env["client"]
    archived = _archive(client, _project(client, env["node"], env["lead"]))

    response = client.post(f"/api/v1/projects/{archived['id']}/unarchive")

    assert response.status_code == 400
    assert response.json()["detail"] == "project_expected_version_required"


def test_unarchive_refuses_a_name_a_live_project_took(env) -> None:
    client = env["client"]
    archived = _archive(client, _project(client, env["node"], env["lead"], name="Taken"))
    _project(client, env["node"], env["lead"], name="Taken")

    response = _unarchive(client, archived)

    assert response.status_code == 409
    assert response.json()["detail"] == "project_name_taken"


def test_only_the_owner_may_unarchive(env) -> None:
    client = env["client"]
    archived = _archive(client, _project(client, env["node"], env["lead"]))
    client.post("/api/v1/auth/logout")
    assert client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "kestrel-vault-7719"},
    ).status_code == 200

    assert _unarchive(client, archived).status_code == 403
    assert client.post(
        "/api/v1/projects/missing/unarchive?expectedVersion=1"
    ).status_code == 404
