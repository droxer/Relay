"""The personal tag catalog: ``/api/v1/account/tags``.

A person's catalog is the tags they saved plus every tag on their own live
Tasks and Automations. Rename, merge, and delete are previewed first and then
applied as ordinary ``task.updated`` events against the previewed state.
"""

from __future__ import annotations

from collections.abc import Iterator
from tempfile import TemporaryDirectory
from typing import Any

import pytest
from fastapi.testclient import TestClient

from automation_helpers import fire_now
from relay.app import create_app
from user_ids import user_id

ALICE = user_id("alice")
BOB = user_id("bob")
TAGS = "/api/v1/account/tags"


def _login(client: TestClient, username: str, password: str) -> None:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text


def _setup(root: str) -> tuple[Any, TestClient, TestClient]:
    app = create_app(root)
    admin = TestClient(app)
    assert admin.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "email": "admin@example.com",
              "password": "kestrel-vault-7719"},
    ).status_code == 200
    for name, identity in (("alice", ALICE), ("bob", BOB)):
        assert admin.post(
            "/api/v1/admin/accounts",
            json={"username": name, "email": f"{name}@example.com", "password": "userpass",
                  "role": "user", "userId": identity},
        ).status_code == 201
    alice, bob = TestClient(app), TestClient(app)
    _login(alice, "alice", "userpass")
    _login(bob, "bob", "userpass")
    return app, alice, bob


@pytest.fixture
def env(monkeypatch) -> Iterator[tuple[Any, TestClient, TestClient, str]]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        app, alice, bob = _setup(root)
        yield app, alice, bob, root


def _task(app: Any, owner: str, tags: list[str], **extra: Any) -> dict[str, Any]:
    return app.state.task_store.create_task(
        {"title": extra.pop("title", "Work"), "ownerUserId": owner, "assigneeUserId": owner,
         "tags": tags, **extra}
    )


def _routine(app: Any, owner: str, tags: list[str]) -> dict[str, Any]:
    return _task(
        app, owner, tags, title="Routine", isRoutine=True, routineEnabled=True,
        routineCadence="weekly", routineNextRunDate="2026-06-25", assignedAgent="codex",
    )


def _tags(client: TestClient, query: str = "") -> dict[str, dict[str, Any]]:
    response = client.get(TAGS, params={"query": query} if query else None)
    assert response.status_code == 200, response.text
    return {tag["name"]: tag for tag in response.json()["tags"]}


def _preview(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    response = client.post(f"{TAGS}/preview", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _apply(client: TestClient, body: dict[str, Any], token: str) -> Any:
    return client.post(f"{TAGS}/apply", json={**body, "previewToken": token})


def test_anonymous_callers_are_refused(env) -> None:
    app, *_ = env
    anonymous = TestClient(app)
    assert anonymous.get(TAGS).status_code == 401
    assert anonymous.post(TAGS, json={"name": "x"}).status_code == 401
    body = {"operation": "delete", "name": "x"}
    assert anonymous.post(f"{TAGS}/preview", json=body).status_code == 401
    assert anonymous.post(f"{TAGS}/apply", json={**body, "previewToken": "t"}).status_code == 401


def test_an_unused_tag_persists_across_app_instances_and_duplicates_conflict(env) -> None:
    _app, alice, _bob, root = env
    created = alice.post(TAGS, json={"name": "  Road   map "})
    assert created.status_code == 201, created.text
    assert created.json()["tag"] == {
        "name": "Road map", "taskCount": 0, "automationCount": 0, "saved": True,
    }
    duplicate = alice.post(TAGS, json={"name": "ROAD MAP"})
    assert (duplicate.status_code, duplicate.json()["detail"]) == (409, "tag_exists")
    for bad in ("", "a,b", "x" * 33, 7, None):
        refused = alice.post(TAGS, json={"name": bad})
        assert (refused.status_code, refused.json()["detail"]) == (400, "tag_invalid"), bad

    fresh = TestClient(create_app(root))
    _login(fresh, "alice", "userpass")
    assert _tags(fresh)["Road map"]["saved"] is True


def test_a_tag_already_on_work_conflicts_on_create(env) -> None:
    app, alice, _bob, _root = env
    _task(app, ALICE, ["Infra"])
    duplicate = alice.post(TAGS, json={"name": "infra"})
    assert (duplicate.status_code, duplicate.json()["detail"]) == (409, "tag_exists")


def test_counts_cover_every_owned_task_and_automation_beyond_a_page(env) -> None:
    app, alice, bob, _root = env
    for index in range(55):
        _task(app, ALICE, ["Bulk", "even" if index % 2 == 0 else "odd"])
    _routine(app, ALICE, ["bulk"])
    _routine(app, ALICE, ["reports"])
    deleted = _task(app, ALICE, ["bulk"])
    app.state.task_store.delete_task(deleted["id"])
    _task(app, BOB, ["Bulk", "secret"])

    listed = _tags(alice)
    assert listed["Bulk"] == {"name": "Bulk", "taskCount": 55, "automationCount": 1, "saved": False}
    assert listed["even"]["taskCount"] == 28
    assert listed["reports"]["automationCount"] == 1
    assert "secret" not in listed
    assert set(_tags(alice, "BU")) == {"Bulk"}

    assert _tags(bob)["Bulk"]["taskCount"] == 1
    assert "even" not in _tags(bob)


def test_another_user_cannot_preview_or_change_my_tags(env) -> None:
    app, alice, bob, _root = env
    task = _task(app, ALICE, ["private"])
    assert alice.post(TAGS, json={"name": "saved-only"}).status_code == 201
    for body in (
        {"operation": "delete", "name": "private"},
        {"operation": "rename", "name": "saved-only", "newName": "mine"},
    ):
        refused = bob.post(f"{TAGS}/preview", json=body)
        assert (refused.status_code, refused.json()["detail"]) == (404, "tag_not_found")
    # A token minted for bob's own (empty) view never reaches alice's records.
    assert bob.post(TAGS, json={"name": "private"}).status_code == 201
    preview = _preview(bob, {"operation": "delete", "name": "private"})
    assert preview["affected"]["taskCount"] == 0
    assert _apply(bob, {"operation": "delete", "name": "private"}, preview["previewToken"]).status_code == 200
    assert app.state.task_store.get_task(task["id"])["tags"] == ["private"]
    assert _tags(alice)["private"]["taskCount"] == 1


def test_rename_updates_tasks_and_automations_through_new_events(env) -> None:
    app, alice, _bob, _root = env
    task = _task(app, ALICE, ["ui", "bug"], status="assigned")
    other = _task(app, ALICE, ["infra"])
    routine = _routine(app, ALICE, ["BUG", "ops"])
    body = {"operation": "rename", "name": "Bug", "newName": "Defect"}

    preview = _preview(alice, body)
    assert preview["operation"] == {"operation": "rename", "name": "Bug", "newName": "Defect"}
    assert preview["affected"]["taskCount"] == 1
    assert preview["affected"]["automationCount"] == 1
    assert {item["id"]: item["tagsAfter"] for item in preview["affected"]["items"]} == {
        task["id"]: ["ui", "Defect"], routine["id"]: ["Defect", "ops"],
    }
    assert preview["excluded"] == {"taskCount": 0, "automationCount": 0, "items": [], "itemsTruncated": False}

    applied = _apply(alice, body, preview["previewToken"])
    assert applied.status_code == 200, applied.text
    assert applied.json()["updated"] == {"taskCount": 1, "automationCount": 1}
    names = {tag["name"]: tag for tag in applied.json()["tags"]}
    assert "bug" not in {name.casefold() for name in names}
    assert names["Defect"] == {"name": "Defect", "taskCount": 1, "automationCount": 1, "saved": True}

    store = app.state.task_store
    after = store.get_task(task["id"])
    assert after["tags"] == ["ui", "Defect"]
    assert after["status"] == task["status"]
    assert store.get_task(other["id"])["tags"] == ["infra"]
    events = after["events"]
    assert events[0]["type"] == "task.created" and events[0]["tags"] == ["ui", "bug"]
    assert events[-1]["type"] == "task.updated"
    assert events[-1]["tags"] == ["ui", "Defect"]
    assert events[-1]["actorUserId"] == ALICE
    assert events[-1]["tagOperation"] == "rename"

    occurrence = fire_now(store, routine["id"], run_date="2026-06-25")
    assert occurrence is not None and occurrence["tags"] == ["Defect", "ops"]


def test_rename_onto_another_existing_tag_conflicts_instead_of_merging(env) -> None:
    app, alice, _bob, _root = env
    _task(app, ALICE, ["a"])
    assert alice.post(TAGS, json={"name": "B"}).status_code == 201
    refused = alice.post(f"{TAGS}/preview", json={"operation": "rename", "name": "a", "newName": "b"})
    assert (refused.status_code, refused.json()["detail"]) == (409, "tag_exists")


def test_case_only_rename_of_a_saved_tag_updates_its_spelling(env) -> None:
    _app, alice, _bob, _root = env
    assert alice.post(TAGS, json={"name": "roadmap"}).status_code == 201
    body = {"operation": "rename", "name": "roadmap", "newName": "Roadmap"}
    preview = _preview(alice, body)
    assert _apply(alice, body, preview["previewToken"]).status_code == 200
    assert set(_tags(alice)) == {"Roadmap"}


def test_merge_deduplicates_and_keeps_other_tags_and_status(env) -> None:
    app, alice, _bob, _root = env
    both = _task(app, ALICE, ["x", "web", "UI", "y"], status="blocked")
    one = _task(app, ALICE, ["frontend"])
    assert alice.post(TAGS, json={"name": "Web-unused"}).status_code == 201
    body = {"operation": "merge", "sources": ["web", "Frontend"], "target": "UI"}
    preview = _preview(alice, body)
    assert preview["affected"]["taskCount"] == 2
    applied = _apply(alice, body, preview["previewToken"])
    assert applied.status_code == 200, applied.text

    store = app.state.task_store
    assert store.get_task(both["id"])["tags"] == ["x", "UI", "y"]
    assert store.get_task(both["id"])["status"] == "blocked"
    assert store.get_task(one["id"])["tags"] == ["UI"]
    listed = _tags(alice)
    assert listed["UI"]["taskCount"] == 2 and listed["UI"]["saved"] is True
    assert not {"web", "frontend"} & {name.casefold() for name in listed}
    assert "Web-unused" in listed


def test_delete_removes_associations_and_the_entry_but_keeps_the_work(env) -> None:
    app, alice, _bob, _root = env
    assert alice.post(TAGS, json={"name": "Temp"}).status_code == 201
    only = _task(app, ALICE, ["temp"])
    mixed = _task(app, ALICE, ["temp", "keep"])
    body = {"operation": "delete", "name": "TEMP"}
    preview = _preview(alice, body)
    assert preview["affected"]["taskCount"] == 2
    assert preview["catalog"] == {"removes": ["Temp"], "saves": None}
    assert _apply(alice, body, preview["previewToken"]).status_code == 200

    store = app.state.task_store
    assert "tags" not in store.get_task(only["id"])
    assert store.get_task(only["id"])["title"] == "Work"
    assert store.get_task(mixed["id"])["tags"] == ["keep"]
    assert "Temp" not in _tags(alice) and "temp" not in _tags(alice)


def test_project_associations_the_owner_cannot_write_are_excluded_and_unchanged(env) -> None:
    app, alice, _bob, _root = env
    projects = app.state.project_store
    live = projects.create_project(ALICE, {"name": "Live", "computerId": "device:a", "members": []})
    archived = projects.create_project(ALICE, {"name": "Old", "computerId": "device:a", "members": []})
    projects.archive_project(archived["id"], expected_version=archived["version"])
    foreign = projects.create_project(BOB, {"name": "Bob secret", "computerId": "device:b", "members": []})
    writable = _task(app, ALICE, ["shared"], projectId=live["id"])
    stale = _task(app, ALICE, ["shared"], projectId=archived["id"])
    elsewhere = _task(app, ALICE, ["shared"], projectId=foreign["id"])
    body = {"operation": "delete", "name": "shared"}

    preview = _preview(alice, body)
    assert [item["id"] for item in preview["affected"]["items"]] == [writable["id"]]
    excluded = {item["id"]: item for item in preview["excluded"]["items"]}
    assert preview["excluded"]["taskCount"] == 2
    assert excluded[stale["id"]]["reason"] == "project_unavailable"
    assert excluded[elsewhere["id"]]["reason"] == "project_not_owned"
    assert "Bob secret" not in str(preview)

    assert _apply(alice, body, preview["previewToken"]).status_code == 200
    store = app.state.task_store
    assert "tags" not in store.get_task(writable["id"])
    assert store.get_task(stale["id"])["tags"] == ["shared"]
    assert store.get_task(elsewhere["id"])["tags"] == ["shared"]
    # The tag stays discoverable through the work it could not leave.
    assert _tags(alice)["shared"] == {"name": "shared", "taskCount": 2, "automationCount": 0, "saved": False}


def test_a_stale_preview_is_refused_and_changes_nothing(env) -> None:
    app, alice, _bob, _root = env
    first = _task(app, ALICE, ["old"])
    body = {"operation": "rename", "name": "old", "newName": "new"}
    preview = _preview(alice, body)
    # A record joins the set after the preview: applying must not reach it.
    late = _task(app, ALICE, ["old"])
    refused = _apply(alice, body, preview["previewToken"])
    assert (refused.status_code, refused.json()["detail"]) == (409, "tag_preview_stale")
    store = app.state.task_store
    assert store.get_task(first["id"])["tags"] == ["old"]
    assert store.get_task(late["id"])["tags"] == ["old"]

    # An edit to a previewed record also invalidates the preview.
    fresh = _preview(alice, body)
    assert alice.patch(f"/api/v1/tasks/{first['id']}", json={"tags": ["old", "extra"]}).status_code == 200
    assert _apply(alice, body, fresh["previewToken"]).status_code == 409
    # Replaying a used token after success is stale too.
    final = _preview(alice, body)
    assert _apply(alice, body, final["previewToken"]).status_code == 200
    assert _apply(alice, body, final["previewToken"]).status_code == 409
    assert {store.get_task(first["id"])["tags"][0], store.get_task(late["id"])["tags"][0]} == {"new"}


def test_apply_requires_a_token_and_a_valid_operation(env) -> None:
    app, alice, _bob, _root = env
    _task(app, ALICE, ["a"])
    missing = alice.post(f"{TAGS}/apply", json={"operation": "delete", "name": "a"})
    assert (missing.status_code, missing.json()["detail"]) == (400, "tag_preview_required")
    bad = alice.post(f"{TAGS}/preview", json={"operation": "rename", "name": "a", "newName": "a,b"})
    assert (bad.status_code, bad.json()["detail"]) == (400, "tag_invalid")


def test_a_failure_part_way_through_rolls_back_every_record_and_the_catalog(env, monkeypatch) -> None:
    app, alice, _bob, _root = env
    store = app.state.task_store
    assert alice.post(TAGS, json={"name": "Gone"}).status_code == 201
    tasks = [_task(app, ALICE, ["gone"]) for _ in range(3)]
    body = {"operation": "delete", "name": "gone"}
    preview = _preview(alice, body)
    original = store.append_events
    calls = {"count": 0}

    def failing(task_id: str, events: list[dict[str, Any]], **kwargs: Any) -> dict[str, Any]:
        calls["count"] += 1
        if calls["count"] == 2:
            raise RuntimeError("disk full")
        return original(task_id, events, **kwargs)

    monkeypatch.setattr(store, "append_events", failing)
    failed = TestClient(app, raise_server_exceptions=False).post(
        f"{TAGS}/apply", json={**body, "previewToken": preview["previewToken"]},
        cookies=alice.cookies,
    )
    assert failed.status_code == 500
    monkeypatch.setattr(store, "append_events", original)
    assert [store.get_task(task["id"])["tags"] for task in tasks] == [["gone"]] * 3
    assert _tags(alice)["Gone"]["saved"] is True
    assert _tags(alice)["Gone"]["taskCount"] == 3


def test_concurrent_applies_and_creates_let_exactly_one_win(env) -> None:
    from concurrent.futures import ThreadPoolExecutor

    app, alice, _bob, _root = env
    tasks = [_task(app, ALICE, ["race"]) for _ in range(5)]
    body = {"operation": "rename", "name": "race", "newName": "Sprint"}
    token = _preview(alice, body)["previewToken"]
    callers = [TestClient(app, cookies=alice.cookies) for _ in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        applied = list(pool.map(lambda client: _apply(client, body, token).status_code, callers))
        created = list(pool.map(
            lambda client: client.post(TAGS, json={"name": "Parallel"}).status_code, callers
        ))
    assert sorted(applied) == [200, 409]
    assert sorted(created) == [201, 409]
    store = app.state.task_store
    histories = [store.get_task(task["id"]) for task in tasks]
    assert all(task["tags"] == ["Sprint"] for task in histories)
    # One rename event per record: the losing apply wrote nothing.
    assert all(
        sum(event.get("tagOperation") == "rename" for event in task["events"]) == 1
        for task in histories
    )
