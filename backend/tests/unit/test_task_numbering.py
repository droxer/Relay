from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from relay.persistence.store_common import materialize_task_events
from relay.persistence.task_numbering import task_number_scope
from relay.persistence.task_store import DatabaseTaskStore, LocalTaskStore
from sqlalchemy import delete, select, update


@pytest.fixture(params=["local", "database"])
def store(request, tmp_path) -> Iterator[LocalTaskStore | DatabaseTaskStore]:
    if request.param == "local":
        yield LocalTaskStore(tmp_path)
    else:
        yield DatabaseTaskStore(f"sqlite:///{tmp_path}/relay.db", create_schema=True)


def _issue(store, owner: str, **extra):
    return store.create_task({"title": "Issue", "ownerEmployeeId": owner, **extra})


def _automation(store, owner: str, **extra):
    return store.create_task(
        {
            "title": "Automation",
            "ownerEmployeeId": owner,
            "isRoutine": True,
            "routineEnabled": True,
            "routineCadence": "weekly",
            "routineNextRunDate": "2026-07-01",
            "assignedAgent": "codex",
            **extra,
        }
    )


def test_scope_puts_automations_before_projects_and_people() -> None:
    assert task_number_scope({"isRoutine": True, "projectId": "p", "ownerEmployeeId": "a"}) == "automation:a"
    assert task_number_scope({"projectId": "p", "ownerEmployeeId": "a"}) == "project:p"
    assert task_number_scope({"ownerEmployeeId": "a"}) == "issue:a"
    assert task_number_scope({}) == "issue:"


def test_project_issues_count_within_their_project(store) -> None:
    numbers = [
        _issue(store, "alice", projectId="project_a")["number"],
        _issue(store, "bob", projectId="project_a")["number"],
        _issue(store, "alice", projectId="project_b")["number"],
        _issue(store, "alice", projectId="project_a")["number"],
    ]

    assert numbers == [1, 2, 1, 3]


def test_automations_count_per_owner_apart_from_issues(store) -> None:
    alice_issue = _issue(store, "alice")
    alice_first = _automation(store, "alice")
    alice_second = _automation(store, "alice")
    bob_first = _automation(store, "bob")

    assert alice_issue["number"] == 1
    assert [alice_first["number"], alice_second["number"], bob_first["number"]] == [1, 2, 1]
    assert alice_first["numberScope"] == "automation:alice"


def test_issues_outside_projects_count_per_owner(store) -> None:
    assert [_issue(store, "alice")["number"], _issue(store, "alice")["number"]] == [1, 2]
    assert _issue(store, "bob")["number"] == 1


def test_moving_an_issue_into_a_project_takes_the_next_project_number(store) -> None:
    _issue(store, "alice", projectId="project_a")
    intake = _issue(store, "alice")
    assert intake["number"] == 1

    moved = store.update_task(intake["id"], {"projectId": "project_a"})

    assert moved["number"] == 2
    assert moved["numberScope"] == "project:project_a"
    assert store.get_task(intake["id"])["number"] == 2
    assert _issue(store, "alice")["number"] == 2


def test_deleted_numbers_are_never_reused(store) -> None:
    first = _issue(store, "alice", projectId="project_a")
    store.delete_task(first["id"])

    assert _issue(store, "alice", projectId="project_a")["number"] == 2


def test_routine_occurrences_are_numbered_as_issues_of_their_scope(store) -> None:
    _issue(store, "alice", projectId="project_a")
    routine = _automation(store, "alice", projectId="project_a")

    occurrence = store.promote_due_routine(routine["id"], "2026-07-01", "2026-07-08")
    manual = store.create_routine_occurrence(routine["id"], "2026-07-02")

    assert routine["number"] == 1
    assert occurrence["number"] == 2
    assert occurrence["numberScope"] == "project:project_a"
    assert manual["number"] == 3


def test_number_survives_replay_from_the_event_log(store) -> None:
    task = _issue(store, "alice", projectId="project_a")

    replayed = materialize_task_events(store.get_task(task["id"])["events"])

    assert replayed["number"] == 1
    assert replayed["numberScope"] == "project:project_a"


def test_numbering_migration_backfills_in_creation_order(tmp_path) -> None:
    store = DatabaseTaskStore(f"sqlite:///{tmp_path}/migration.db", create_schema=True)
    created = [
        _issue(store, "alice", projectId="project_a"),
        _automation(store, "alice"),
        _issue(store, "alice", projectId="project_a"),
        _issue(store, "alice"),
    ]
    path = (
        Path(__file__).parents[2]
        / "migrations/versions/20261006_0083_task_numbers.py"
    )
    spec = importlib.util.spec_from_file_location("task_numbers_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with store.engine.begin() as conn:
        # Rewind to a pre-numbering database: no numbers anywhere.
        for task in created:
            row = conn.execute(
                select(store.tasks.c.snapshot).where(store.tasks.c.id == task["id"])
            ).scalar_one()
            legacy = {k: v for k, v in row.items() if k not in ("number", "numberScope")}
            conn.execute(
                update(store.tasks)
                .where(store.tasks.c.id == task["id"])
                .values(snapshot=legacy, number=None, number_scope=None)
            )
            created_event = conn.execute(
                select(store.events.c.id, store.events.c.payload).where(
                    store.events.c.task_id == task["id"],
                    store.events.c.type == "task.created",
                )
            ).one()
            payload = {
                k: v
                for k, v in created_event.payload.items()
                if k not in ("number", "numberScope")
            }
            conn.execute(
                update(store.events)
                .where(store.events.c.id == created_event.id)
                .values(payload=payload)
            )
        conn.execute(delete(store.number_counters))
        module.op = Operations(MigrationContext.configure(conn))
        module.backfill(conn)

    numbered = [store.get_task(task["id"]) for task in created]
    assert [task["number"] for task in numbered] == [1, 1, 2, 1]
    assert numbered[1]["numberScope"] == "automation:alice"
    assert numbered[0]["events"][-1]["type"] == "task.numbered"
    assert materialize_task_events(numbered[2]["events"])["number"] == 2
    assert _issue(store, "alice", projectId="project_a")["number"] == 3
