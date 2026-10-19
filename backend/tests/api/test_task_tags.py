from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient

from automation_helpers import WEEKLY_TRIGGERS, fire_now
from relay.app import create_app
from relay.core.task_tags import MAX_TAGS, normalize_tags
from relay.persistence.task.store import DatabaseTaskStore
from user_ids import user_id

ALICE = user_id("alice")


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        client = TestClient(create_app(root))
        assert client.post(
            "/api/v1/auth/bootstrap",
            json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
        ).status_code == 200
        yield client


def test_normalize_tags_trims_collapses_and_dedupes_case_insensitively() -> None:
    assert normalize_tags(["  Front  end ", "front END", "infra"]) == ["Front end", "infra"]
    assert normalize_tags([]) == []


@pytest.mark.parametrize(
    "value",
    ["frontend", [""], ["a,b"], [1], ["x" * 33], [f"t{index}" for index in range(MAX_TAGS + 1)]],
)
def test_normalize_tags_refuses_invalid_lists(value) -> None:
    with pytest.raises(ValueError):
        normalize_tags(value)


def test_task_tags_are_set_on_create_replaced_and_cleared_on_patch(client) -> None:
    created = client.post(
        "/api/v1/tasks",
        json={"title": "Tagged", "ownerUserId": ALICE, "tags": ["Bug", " bug ", "ui"]},
    )
    assert created.status_code == 201, created.text
    task = created.json()
    assert task["tags"] == ["Bug", "ui"]

    renamed = client.patch(f"/api/v1/tasks/{task['id']}", json={"title": "Renamed"})
    assert renamed.json()["tags"] == ["Bug", "ui"]

    replaced = client.patch(f"/api/v1/tasks/{task['id']}", json={"tags": ["infra"]})
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["tags"] == ["infra"]

    cleared = client.patch(f"/api/v1/tasks/{task['id']}", json={"tags": []})
    assert cleared.status_code == 200, cleared.text
    assert "tags" not in cleared.json()

    listed = client.get("/api/v1/tasks?view=summary").json()["tasks"]
    assert "tags" not in next(item for item in listed if item["id"] == task["id"])


def test_task_tags_refuse_an_invalid_list(client) -> None:
    refused = client.post(
        "/api/v1/tasks", json={"title": "Bad", "ownerUserId": ALICE, "tags": "bug"}
    )
    assert refused.status_code == 400
    assert "tags must be a list" in refused.json()["detail"]

    created = client.post("/api/v1/tasks", json={"title": "Ok", "ownerUserId": ALICE})
    refused_patch = client.patch(
        f"/api/v1/tasks/{created.json()['id']}", json={"tags": ["a,b"]}
    )
    assert refused_patch.status_code == 400


def test_automation_tags_round_trip_through_the_api(client) -> None:
    created = client.post(
        "/api/v1/tasks",
        json={
            "title": "Nightly report",
            "ownerUserId": ALICE,
            "isRoutine": True,
            "routineTriggers": WEEKLY_TRIGGERS,
            "routineState": "paused",
            "tags": ["reports"],
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["tags"] == ["reports"]
    listed = client.get("/api/v1/tasks?view=summary").json()["tasks"]
    assert next(item for item in listed if item["id"] == created.json()["id"])["tags"] == ["reports"]


def test_routine_occurrence_inherits_the_routine_tags() -> None:
    with TemporaryDirectory() as root:
        store = DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
        routine = store.create_task(
            {
                "title": "Routine",
                "isRoutine": True,
                "routineEnabled": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-25",
                "assignedAgent": "codex",
                "ownerUserId": "alice",
                "assigneeUserId": "alice",
                "tags": ["ops", "weekly"],
            }
        )

        occurrence = fire_now(store, routine["id"], run_date="2026-06-25")

        assert occurrence is not None
        assert occurrence["tags"] == ["ops", "weekly"]
