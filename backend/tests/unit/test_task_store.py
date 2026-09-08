from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from relay.persistence.session_store import DatabaseSessionStore, LocalSessionStore
from relay.persistence.store_common import relay_task_event
from relay.persistence.task_store import (
    DatabaseTaskStore,
    LocalTaskStore,
    TaskExecutionActiveError,
)
from sqlalchemy import event, text


def test_task_store_persists_assignment_status_activity_and_link() -> None:
    with TemporaryDirectory() as root:
        store = LocalTaskStore(root)
        task = store.create_task(
            {
                "title": "Add Kanban board",
                "description": "Show backlog.",
                "priority": "high",
                "assigneeEmployeeId": "alice",
                "dueDate": "2026-06-30",
                "isRoutine": True,
                "routineType": "job",
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-25",
                "routineEnabled": True,
            }
        )
        task = store.assign_task(task["id"], "codex", "agent_builder")
        task = store.update_task(
            task["id"], {"routineNextRunDate": "2026-07-02", "routineEnabled": False}
        )
        task = store.link_session(task["id"], "ses_test")
        task = store.update_task(task["id"], {"status": "running"})

        assert task["assigneeEmployeeId"] == "alice"
        assert task["dueDate"] == "2026-06-30"
        assert task["isRoutine"] is True
        assert task["routineType"] == "job"
        assert task["routineCadence"] == "weekly"
        assert task["routineNextRunDate"] == "2026-07-02"
        assert task["routineEnabled"] is False
        assert task["assignedAgent"] == "codex"
        assert task["assignedAgentId"] == "agent_builder"
        assert task["linkedSessionIds"] == ["ses_test"]
        assert task["status"] == "running"
        assert any("Assigned to codex" in item["message"] for item in task["activity"])


def test_local_task_store_link_session_is_idempotent() -> None:
    with TemporaryDirectory() as root:
        store = LocalTaskStore(root)
        task = store.create_task({"title": "Link once"})

        with ThreadPoolExecutor(max_workers=2) as pool:
            list(
                pool.map(lambda _: store.link_session(task["id"], "ses_test"), range(2))
            )
        linked = store.get_task(task["id"])

        assert linked["linkedSessionIds"] == ["ses_test"]
        assert (
            sum(event["type"] == "task.session_linked" for event in linked["events"])
            == 1
        )
        assert (
            sum(
                activity["message"] == "Linked session ses_test."
                for activity in linked["activity"]
            )
            == 1
        )


def test_local_task_store_serializes_concurrent_appends() -> None:
    with TemporaryDirectory() as root:
        store = LocalTaskStore(root)
        task = store.create_task(
            {"title": "Collect activity", "description": "", "priority": "normal"}
        )
        assert task["isRoutine"] is False
        assert task["routineEnabled"] is False

        def append(index: int) -> None:
            store.append_event(
                task["id"],
                relay_task_event(
                    "task.activity",
                    task["id"],
                    {
                        "activity": {
                            "id": f"act_{index}",
                            "createdAt": "2026-06-05T00:00:00.000Z",
                            "message": f"Activity {index}",
                        }
                    },
                ),
            )

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(append, range(25)))

        updated = store.get_task(task["id"])
        assert len(updated["activity"]) == 25
        assert {activity["id"] for activity in updated["activity"]} == {
            f"act_{index}" for index in range(25)
        }


def test_database_task_store_persists_assignment_status_activity_and_link() -> None:
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/relay.db"
        session_store = DatabaseSessionStore(database_url, create_schema=True)
        store = DatabaseTaskStore(database_url, create_schema=True)
        session = session_store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "linked task",
                "participants": ["human"],
            }
        )
        task = store.create_task(
            {
                "title": "Add Kanban board",
                "description": "Show backlog.",
                "priority": "high",
                "assigneeEmployeeId": "alice",
                "dueDate": "2026-06-30",
                "isRoutine": True,
                "routineType": "job",
                "routineCadence": "monthly",
                "routineNextRunDate": "2026-06-25",
                "routineEnabled": True,
            }
        )
        task = store.assign_task(task["id"], "codex", "agent_builder")
        task = store.update_task(
            task["id"], {"routineNextRunDate": "2026-07-25", "routineEnabled": False}
        )
        task = store.link_session(task["id"], session["id"])
        task = store.update_task(task["id"], {"status": "running"})

        assert task["assigneeEmployeeId"] == "alice"
        assert task["dueDate"] == "2026-06-30"
        assert task["isRoutine"] is True
        assert task["routineType"] == "job"
        assert task["routineCadence"] == "monthly"
        assert task["routineNextRunDate"] == "2026-07-25"
        assert task["routineEnabled"] is False
        assert task["assignedAgent"] == "codex"
        assert task["assignedAgentId"] == "agent_builder"
        assert task["linkedSessionIds"] == [session["id"]]
        assert task["status"] == "running"
        assert store.list_tasks()[0]["id"] == task["id"]
        assert any("Assigned to codex" in item["message"] for item in task["activity"])


def test_database_task_snapshot_excludes_authoritative_histories() -> None:
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/compact.db"
        store = DatabaseTaskStore(database_url, create_schema=True)
        task = store.create_task({"title": "Keep the snapshot bounded"})
        for index in range(10):
            store.record_activity(task["id"], f"Activity {index}")

        with store.engine.begin() as conn:
            raw_snapshot = conn.execute(
                text("select snapshot from tasks where id = :id"), {"id": task["id"]}
            ).scalar_one()
        snapshot = json.loads(raw_snapshot) if isinstance(raw_snapshot, str) else raw_snapshot

        assert "events" not in snapshot
        assert "activity" not in snapshot
        assert snapshot["eventCount"] == len(store.get_task(task["id"])["events"])
        assert len(store.get_task(task["id"])["activity"]) == 10


def test_database_task_summaries_project_histories_before_transfer() -> None:
    with TemporaryDirectory() as root:
        store = DatabaseTaskStore(
            f"sqlite:///{root}/summary.db", create_schema=True
        )
        task = store.create_task({"title": "Compact at the database boundary"})
        store.record_activity(task["id"], "Projected activity")
        statements: list[str] = []

        def capture_statement(_conn, _cursor, statement, _params, _context, _many):
            statements.append(statement)

        event.listen(store.engine, "before_cursor_execute", capture_statement)
        try:
            summaries = store.list_task_summaries()
        finally:
            event.remove(store.engine, "before_cursor_execute", capture_statement)

        summary_select = next(
            statement
            for statement in statements
            if statement.lstrip().upper().startswith("SELECT")
        )
        assert "json_remove(tasks.snapshot" not in summary_select
        assert "tasks.snapshot" in summary_select
        assert "events" not in summaries[0]
        assert "activity" not in summaries[0]
        assert summaries[0]["lastActivity"]["message"] == "Projected activity"


def test_database_task_store_link_session_is_idempotent() -> None:
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/relay.db"
        session_store = DatabaseSessionStore(database_url, create_schema=True)
        store = DatabaseTaskStore(database_url, create_schema=True)
        other_store = DatabaseTaskStore(database_url)
        session = session_store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "link once",
                "participants": ["human"],
            }
        )
        task = store.create_task({"title": "Link once"})

        with ThreadPoolExecutor(max_workers=2) as pool:
            list(
                pool.map(
                    lambda task_store: task_store.link_session(
                        task["id"], session["id"]
                    ),
                    (store, other_store),
                )
            )
        linked = store.get_task(task["id"])

        assert linked["linkedSessionIds"] == [session["id"]]
        assert (
            sum(event["type"] == "task.session_linked" for event in linked["events"])
            == 1
        )
        assert (
            sum(
                activity["message"] == f"Linked session {session['id']}."
                for activity in linked["activity"]
            )
            == 1
        )


def test_task_claim_orders_by_priority_due_date_and_assignee() -> None:
    with TemporaryDirectory() as root:
        store = LocalTaskStore(root)
        later = store.create_task(
            {
                "title": "Later",
                "priority": "high",
                "assigneeEmployeeId": "alice",
                "dueDate": "2026-07-10",
            }
        )
        earlier = store.create_task(
            {
                "title": "Earlier",
                "priority": "high",
                "assigneeEmployeeId": "alice",
                "dueDate": "2026-06-25",
            }
        )
        wrong_assignee = store.create_task(
            {
                "title": "Bob",
                "priority": "high",
                "assigneeEmployeeId": "bob",
                "dueDate": "2026-06-01",
            }
        )
        for task in (later, earlier, wrong_assignee):
            store.assign_task(task["id"], "codex")

        claimed = store.claim_next_task_for_agent("codex", "alice")

        assert claimed is not None
        assert claimed["id"] == earlier["id"]
        assert claimed["status"] == "assigned"
        assert claimed["dispatchClaim"]["id"]
        assert store.get_task(wrong_assignee["id"])["status"] == "assigned"


def test_task_store_claims_exact_task_for_dispatch() -> None:
    with TemporaryDirectory() as root:
        store = LocalTaskStore(root)
        routine = store.create_task(
            {
                "title": "Routine",
                "isRoutine": True,
                "routineEnabled": True,
                "assignedAgent": "codex",
                "status": "assigned",
            }
        )
        task = store.create_task(
            {"title": "Dispatch me", "assignedAgent": "codex", "status": "assigned"}
        )

        assert store.claim_task_for_dispatch(routine["id"], "codex") is None
        claimed = store.claim_task_for_dispatch(task["id"], "codex")
        second_claim = store.claim_task_for_dispatch(task["id"], "codex")

        assert claimed is not None
        assert claimed["status"] == "assigned"
        assert claimed["dispatchClaim"]["id"]
        assert second_claim is None


@pytest.mark.parametrize("database", [False, True])
def test_task_store_persists_dispatch_retry_state(database: bool) -> None:
    with TemporaryDirectory() as root:
        store = (
            DatabaseTaskStore(f"sqlite:///{root}/tasks.db", create_schema=True)
            if database
            else LocalTaskStore(root)
        )
        task = store.create_task({"title": "Retry a queued dispatch"})

        updated = store.record_dispatch_retry(
            task["id"],
            failure_count=2,
            next_attempt_at="2026-06-25T00:01:00Z",
            code="agent_offline",
            message="No agent node is ready.",
        )

        assert updated["dispatchRetry"] == {
            "failureCount": 2,
            "nextAttemptAt": "2026-06-25T00:01:00Z",
            "code": "agent_offline",
            "message": "No agent node is ready.",
        }
        replayed = store.get_task(task["id"])
        assert replayed["dispatchRetry"] == updated["dispatchRetry"]


@pytest.mark.parametrize("database", [False, True])
def test_dispatchable_tasks_exclude_future_retry_deadlines(database: bool) -> None:
    with TemporaryDirectory() as root:
        store = (
            DatabaseTaskStore(f"sqlite:///{root}/tasks.db", create_schema=True)
            if database
            else LocalTaskStore(root)
        )
        waiting = store.create_task(
            {"title": "Wait", "assignedAgent": "codex", "status": "assigned"}
        )
        ready = store.create_task(
            {"title": "Ready", "assignedAgent": "codex", "status": "assigned"}
        )
        store.record_dispatch_retry(
            waiting["id"],
            failure_count=1,
            next_attempt_at="2099-01-01T00:00:00Z",
        )

        dispatchable = store.list_dispatchable_tasks()

        assert [task["id"] for task in dispatchable] == [ready["id"]]


def test_task_store_promotes_due_routine_once() -> None:
    with TemporaryDirectory() as root:
        store = LocalTaskStore(root)
        routine = store.create_task(
            {
                "title": "Routine",
                "description": "Run it.",
                "priority": "high",
                "isRoutine": True,
                "routineEnabled": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-25",
                "assignedAgent": "codex",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
            }
        )

        first = store.promote_due_routine(routine["id"], "2026-06-25", "2026-07-02")
        second = store.promote_due_routine(routine["id"], "2026-06-25", "2026-07-09")

        assert first is not None
        assert first["status"] == "assigned"
        assert first["isRoutine"] is False
        assert first["assignedAgent"] == "codex"
        assert first["dueDate"] == "2026-06-25"
        assert second is None
        updated = store.get_task(routine["id"])
        assert updated["routineNextRunDate"] == "2026-07-02"
        assert (
            len([task for task in store.list_tasks() if task["id"] != routine["id"]])
            == 1
        )


def test_task_store_updates_routine_and_assignment_in_one_event_batch() -> None:
    with TemporaryDirectory() as root:
        store = LocalTaskStore(root)
        task = store.create_task(
            {
                "title": "Atomic routine",
                "isRoutine": True,
                "routineEnabled": False,
            }
        )

        updated = store.update_task(
            task["id"],
            {"routineEnabled": True, "routineNextRunDate": "2026-07-31"},
            assignment={"agent": "codex", "agentId": "agent_builder"},
        )

        assert updated["routineEnabled"] is True
        assert updated["assignedAgentId"] == "agent_builder"
        assert [event["type"] for event in updated["events"][-3:]] == [
            "task.updated",
            "task.assigned",
            "task.activity",
        ]


def assert_manual_routine_occurrence_is_idempotent(
    store: LocalTaskStore | DatabaseTaskStore,
) -> None:
    routine = store.create_task(
        {
            "title": "Run once",
            "isRoutine": True,
            "routineEnabled": True,
            "routineCadence": "custom",
            "routineNextRunDate": "2026-07-31",
            "assignedAgent": "codex",
            "assignedAgentId": "agent_builder",
        }
    )

    first = store.create_routine_occurrence(routine["id"], "2026-07-30")
    second = store.create_routine_occurrence(routine["id"], "2026-07-30")

    store.update_task(first["id"], {"status": "review"})
    while_in_review = store.create_routine_occurrence(routine["id"], "2026-07-30")
    store.update_task(first["id"], {"status": "done"})
    after_completion = store.create_routine_occurrence(routine["id"], "2026-07-30")

    assert second["id"] == first["id"]
    assert while_in_review["id"] == first["id"]
    assert after_completion["id"] == first["id"]
    assert store.get_task(routine["id"])["occurrenceIds"] == [first["id"]]


def test_local_manual_routine_occurrence_is_idempotent() -> None:
    with TemporaryDirectory() as root:
        assert_manual_routine_occurrence_is_idempotent(LocalTaskStore(root))


def test_database_manual_routine_occurrence_is_idempotent() -> None:
    with TemporaryDirectory() as root:
        assert_manual_routine_occurrence_is_idempotent(
            DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
        )


def test_database_task_claim_orders_by_priority_due_date_and_assignee() -> None:
    with TemporaryDirectory() as root:
        store = DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
        later = store.create_task(
            {
                "title": "Later",
                "priority": "high",
                "assigneeEmployeeId": "alice",
                "dueDate": "2026-07-10",
            }
        )
        earlier = store.create_task(
            {
                "title": "Earlier",
                "priority": "high",
                "assigneeEmployeeId": "alice",
                "dueDate": "2026-06-25",
            }
        )
        wrong_assignee = store.create_task(
            {
                "title": "Bob",
                "priority": "high",
                "assigneeEmployeeId": "bob",
                "dueDate": "2026-06-01",
            }
        )
        for task in (later, earlier, wrong_assignee):
            store.assign_task(task["id"], "codex")

        claimed = store.claim_next_task_for_agent("codex", "alice")

        assert claimed is not None
        assert claimed["id"] == earlier["id"]
        assert claimed["status"] == "assigned"
        assert claimed["dispatchClaim"]["id"]
        assert store.get_task(wrong_assignee["id"])["status"] == "assigned"


def test_database_task_store_claims_exact_task_for_dispatch() -> None:
    with TemporaryDirectory() as root:
        store = DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
        routine = store.create_task(
            {
                "title": "Routine",
                "isRoutine": True,
                "routineEnabled": True,
                "assignedAgent": "codex",
                "status": "assigned",
            }
        )
        task = store.create_task(
            {"title": "Dispatch me", "assignedAgent": "codex", "status": "assigned"}
        )

        assert store.claim_task_for_dispatch(routine["id"], "codex") is None
        claimed = store.claim_task_for_dispatch(task["id"], "codex")
        second_claim = store.claim_task_for_dispatch(task["id"], "codex")

        assert claimed is not None
        assert claimed["status"] == "assigned"
        assert claimed["dispatchClaim"]["id"]
        assert second_claim is None


def assert_store_guards_updates_during_dispatch(store) -> None:
    task = store.create_task(
        {"title": "Guard me", "assignedAgent": "codex", "status": "assigned"}
    )
    claimed = store.claim_task_for_dispatch(task["id"], "codex")
    assert claimed is not None

    with pytest.raises(TaskExecutionActiveError, match="task_execution_active"):
        store.update_task_if_not_dispatching(task["id"], {"status": "done"})

    metadata = store.update_task(task["id"], {"title": "Metadata remains editable"})
    assert metadata["title"] == "Metadata remains editable"
    assert metadata["dispatchClaim"] == claimed["dispatchClaim"]


def test_local_task_store_guards_updates_during_dispatch() -> None:
    with TemporaryDirectory() as root:
        assert_store_guards_updates_during_dispatch(LocalTaskStore(root))


def test_database_task_store_guards_updates_during_dispatch() -> None:
    with TemporaryDirectory() as root:
        assert_store_guards_updates_during_dispatch(
            DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
        )


def assert_store_lists_scheduler_queues(
    store: LocalTaskStore | DatabaseTaskStore,
) -> None:
    low = store.create_task(
        {
            "title": "Low priority",
            "priority": "low",
            "assignedAgent": "codex",
            "status": "assigned",
            "dueDate": "2026-05-01",
        }
    )
    high = store.create_task(
        {
            "title": "High priority",
            "priority": "high",
            "assignedAgent": "codex",
            "status": "assigned",
            "dueDate": "2026-07-10",
        }
    )
    normal = store.create_task(
        {
            "title": "Normal priority",
            "priority": "normal",
            "assignedAgent": "codex",
            "status": "assigned",
            "dueDate": "2026-06-01",
        }
    )
    store.create_task({"title": "Unassigned", "status": "assigned"})
    store.create_task({"title": "Backlog", "assignedAgent": "codex"})
    store.create_task({"title": "Done", "assignedAgent": "codex", "status": "done"})
    store.create_task(
        {
            "title": "Routine occurrence source",
            "assignedAgent": "codex",
            "status": "assigned",
            "isRoutine": True,
            "routineEnabled": True,
        }
    )

    due_routine = store.create_task(
        {
            "title": "Due routine",
            "isRoutine": True,
            "routineEnabled": True,
            "routineCadence": "weekly",
            "routineNextRunDate": "2026-06-25",
            "assignedAgent": "codex",
        }
    )
    store.create_task(
        {
            "title": "Future routine",
            "isRoutine": True,
            "routineEnabled": True,
            "routineCadence": "weekly",
            "routineNextRunDate": "2026-07-25",
            "assignedAgent": "codex",
        }
    )
    if isinstance(store, LocalTaskStore):
        store.create_task(
            {
                "title": "Invalid routine",
                "isRoutine": True,
                "routineEnabled": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "not-a-date",
                "assignedAgent": "codex",
            }
        )

    assert [task["id"] for task in store.list_dispatchable_tasks()] == [
        high["id"],
        normal["id"],
        low["id"],
    ]
    assert [task["id"] for task in store.list_dispatchable_tasks(limit=2)] == [
        high["id"],
        normal["id"],
    ]
    assert [task["id"] for task in store.list_due_routines("2026-06-25")] == [
        due_routine["id"]
    ]


def test_local_task_store_lists_scheduler_queues() -> None:
    with TemporaryDirectory() as root:
        assert_store_lists_scheduler_queues(LocalTaskStore(root))


def test_database_task_store_lists_scheduler_queues() -> None:
    with TemporaryDirectory() as root:
        assert_store_lists_scheduler_queues(
            DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
        )


def test_database_task_store_promotes_due_routine_once() -> None:
    with TemporaryDirectory() as root:
        store = DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
        routine = store.create_task(
            {
                "title": "Routine",
                "description": "Run it.",
                "priority": "high",
                "isRoutine": True,
                "routineEnabled": True,
                "routineCadence": "weekly",
                "routineNextRunDate": "2026-06-25",
                "assignedAgent": "codex",
                "ownerEmployeeId": "alice",
                "assigneeEmployeeId": "alice",
            }
        )

        first = store.promote_due_routine(routine["id"], "2026-06-25", "2026-07-02")
        second = store.promote_due_routine(routine["id"], "2026-06-25", "2026-07-09")

        assert first is not None
        assert first["status"] == "assigned"
        assert first["isRoutine"] is False
        assert first["assignedAgent"] == "codex"
        assert first["dueDate"] == "2026-06-25"
        assert second is None
        updated = store.get_task(routine["id"])
        assert updated["routineNextRunDate"] == "2026-07-02"
        assert (
            len([task for task in store.list_tasks() if task["id"] != routine["id"]])
            == 1
        )


def assert_store_supports_canonical_assignment_and_dispatch_leases(store) -> None:
    task = store.create_task(
        {
            "title": "Keep explicit state",
            "status": "blocked",
            "ownerEmployeeId": "alice",
            "assigneeEmployeeId": "alice",
        }
    )

    assigned = store.set_task_assignment(task["id"], "codex", "agent_builder")
    assert assigned["status"] == "blocked"
    assert assigned["assignedAgentId"] == "agent_builder"

    store.update_task(task["id"], {"status": "assigned"})
    claimed = store.claim_task_for_dispatch(task["id"], "codex")
    assert claimed is not None
    assert claimed["status"] == "assigned"
    assert claimed["dispatchClaim"]["id"]
    assert store.claim_task_for_dispatch(task["id"], "codex") is None

    released = store.release_dispatch_claim(task["id"], claimed["dispatchClaim"]["id"])
    assert "dispatchClaim" not in released
    assert released["assignedAgentId"] == "agent_builder"

    store.append_event(
        task["id"],
        relay_task_event(
            "task.dispatch_claimed",
            task["id"],
            {
                "claim": {
                    "id": "claim_abandoned",
                    "claimedAt": "2020-01-01T00:00:00Z",
                    "expiresAt": "2020-01-01T00:01:00Z",
                }
            },
        ),
    )
    recovered = store.claim_task_for_dispatch(task["id"], "codex")
    assert recovered is not None
    assert recovered["dispatchClaim"]["id"] == "claim_abandoned"
    assert recovered["dispatchClaim"]["expiresAt"] != "2020-01-01T00:01:00Z"
    assert store.claim_task_for_dispatch(task["id"], "codex") is None
    store.release_dispatch_claim(task["id"], recovered["dispatchClaim"]["id"])

    unassigned = store.unassign_task(task["id"])
    assert "assignedAgent" not in unassigned
    assert "assignedAgentId" not in unassigned
    assert unassigned["status"] == "assigned"


def test_local_task_store_supports_canonical_assignment_and_dispatch_leases() -> None:
    with TemporaryDirectory() as root:
        assert_store_supports_canonical_assignment_and_dispatch_leases(
            LocalTaskStore(root)
        )


def test_database_task_store_supports_canonical_assignment_and_dispatch_leases() -> (
    None
):
    with TemporaryDirectory() as root:
        assert_store_supports_canonical_assignment_and_dispatch_leases(
            DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
        )


def assert_store_records_routine_occurrence_lineage(store) -> None:
    routine = store.create_task(
        {
            "title": "Weekly report",
            "isRoutine": True,
            "routineEnabled": True,
            "routineCadence": "weekly",
            "routineNextRunDate": "2026-06-25",
            "assignedAgent": "codex",
            "assignedAgentId": "agent_builder",
            "ownerEmployeeId": "alice",
            "assigneeEmployeeId": "alice",
        }
    )

    occurrence = store.promote_due_routine(routine["id"], "2026-06-25", "2026-07-02")

    assert occurrence is not None
    assert occurrence["sourceRoutineId"] == routine["id"]
    assert occurrence["scheduledFor"] == "2026-06-25"
    assert occurrence["assignedAgentId"] == "agent_builder"
    updated = store.get_task(routine["id"])
    assert updated["occurrenceIds"] == [occurrence["id"]]


def test_local_task_store_records_routine_occurrence_lineage() -> None:
    with TemporaryDirectory() as root:
        assert_store_records_routine_occurrence_lineage(LocalTaskStore(root))


def test_database_task_store_records_routine_occurrence_lineage() -> None:
    with TemporaryDirectory() as root:
        assert_store_records_routine_occurrence_lineage(
            DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
        )


def assert_store_delete_hides_task_everywhere(store, session_store) -> None:
    session = session_store.create_session(
        {
            "workspacePath": "/workspace",
            "taskGoal": "Linked work",
            "participants": ["human", "codex"],
            "ownerEmployeeId": "alice",
        }
    )
    late_session = session_store.create_session(
        {
            "workspacePath": "/workspace",
            "taskGoal": "Too-late work",
            "participants": ["human"],
            "ownerEmployeeId": "alice",
        }
    )
    routine = store.create_task(
        {
            "title": "Due routine",
            "description": "",
            "priority": "normal",
            "isRoutine": True,
            "routineEnabled": True,
            "routineCadence": "weekly",
            "routineNextRunDate": "2026-06-25",
        }
    )
    assigned = store.create_task(
        {"title": "Dispatchable", "description": "", "priority": "high"}
    )
    assigned = store.assign_task(assigned["id"], "codex")
    active = store.create_task(
        {"title": "Claimed", "description": "", "priority": "normal"}
    )
    active = store.assign_task(active["id"], "codex")
    linked = store.create_task(
        {"title": "Linked", "description": "", "priority": "normal"}
    )
    store.link_session(linked["id"], session["id"])
    with pytest.raises(TaskExecutionActiveError, match="task_execution_active"):
        store.delete_task(
            linked["id"],
            active_linked_session=lambda task: (
                session["id"] in task.get("linkedSessionIds", [])
            ),
        )
    assert store.claim_task_for_dispatch(active["id"], "codex") is not None
    with pytest.raises(TaskExecutionActiveError, match="task_execution_active"):
        store.delete_task(active["id"], reject_active_claim=True)

    deleted = store.delete_task(routine["id"], deleted_by="alice")
    assert deleted["deletedAt"]
    assert deleted["deletedByEmployeeId"] == "alice"
    deleted_event = next(
        event for event in deleted["events"] if event["type"] == "task.deleted"
    )
    assert deleted_event["actorEmployeeId"] == "alice"
    again = store.delete_task(routine["id"])
    assert again["deletedAt"] == deleted["deletedAt"]
    assert (
        len([event for event in again["events"] if event["type"] == "task.deleted"])
        == 1
    )

    deleted_assigned = store.delete_task(assigned["id"], reject_active_claim=True)
    assert deleted_assigned["deletedAt"]

    store.release_dispatch_claim(
        active["id"], store.get_task(active["id"])["dispatchClaim"]["id"]
    )
    assert store.delete_task(active["id"], reject_active_claim=True)["deletedAt"]
    assert store.delete_task(linked["id"], active_linked_session=lambda _task: False)[
        "deletedAt"
    ]
    relinked = store.link_session(linked["id"], late_session["id"])
    assert late_session["id"] not in relinked["linkedSessionIds"]

    assert store.list_tasks() == []
    assert store.list_due_routines("2026-06-25") == []
    assert store.list_dispatchable_tasks() == []
    assert store.claim_next_task_for_agent("codex") is None
    assert store.claim_task_for_dispatch(assigned["id"], "codex") is None
    assert store.promote_due_routine(routine["id"], "2026-06-25", "2026-07-02") is None
    assert store.create_routine_occurrence(routine["id"], "2026-06-25") is None

    persisted = store.get_task(routine["id"])
    assert persisted["deletedAt"] == deleted["deletedAt"]


def test_local_task_store_delete_hides_task_everywhere() -> None:
    with TemporaryDirectory() as root:
        assert_store_delete_hides_task_everywhere(
            LocalTaskStore(root), LocalSessionStore(root)
        )


def test_database_task_store_delete_hides_task_everywhere() -> None:
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/relay.db"
        assert_store_delete_hides_task_everywhere(
            DatabaseTaskStore(database_url, create_schema=True),
            DatabaseSessionStore(database_url),
        )


def assert_team_assignment_contract(store) -> None:
    task = store.create_task(
        {
            "title": "Ship together",
            "ownerEmployeeId": "alice",
            "assigneeEmployeeId": "alice",
            "assignedTeamId": "team_delivery",
            "status": "assigned",
        }
    )

    assert task["assignedTeamId"] == "team_delivery"
    assert "assignedAgent" not in task
    assert store.list_dispatchable_tasks()[0]["id"] == task["id"]
    assert store.claim_next_task_for_agent("codex", "alice") is None

    assigned = store.set_task_assignment(task["id"], "codex", "agent_builder")
    assert assigned["assignedAgentId"] == "agent_builder"
    assert "assignedTeamId" not in assigned

    reassigned = store.set_task_team_assignment(task["id"], "team_delivery")
    assert reassigned["assignedTeamId"] == "team_delivery"
    assert "assignedAgentId" not in reassigned

    cleared = store.unassign_task(task["id"])
    assert "assignedTeamId" not in cleared
    assert "assignedAgentId" not in cleared


def test_local_task_store_team_assignment_contract() -> None:
    with TemporaryDirectory() as root:
        assert_team_assignment_contract(LocalTaskStore(root))


def test_database_task_store_team_assignment_contract() -> None:
    with TemporaryDirectory() as root:
        assert_team_assignment_contract(
            DatabaseTaskStore(f"sqlite:///{root}/team-tasks.db", create_schema=True)
        )


def test_database_task_store_unlinks_session() -> None:
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/unlink.db"
        session_store = DatabaseSessionStore(database_url, create_schema=True)
        store = DatabaseTaskStore(database_url, create_schema=True)
        session = session_store.create_session(
            {
                "workspacePath": "/workspace",
                "taskGoal": "unlink deleted thread",
                "participants": ["human"],
            }
        )
        task = store.create_task({"title": "Unlink deleted thread"})
        store.link_session(task["id"], session["id"])

        updated = store.unlink_session(task["id"], session["id"])
        repeated = store.unlink_session(task["id"], session["id"])

        assert updated["linkedSessionIds"] == []
        assert repeated["linkedSessionIds"] == []
        assert (
            sum(
                event["type"] == "task.session_unlinked" for event in repeated["events"]
            )
            == 1
        )


def test_database_task_store_rejects_link_to_unknown_session(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path}/relay.db"
    DatabaseSessionStore(database_url, create_schema=True)
    store = DatabaseTaskStore(database_url, create_schema=True)
    task = store.create_task({"title": "Reject dangling link"})

    with pytest.raises(KeyError, match="Unknown session"):
        store.link_session(task["id"], "22222222-2222-4222-8222-222222222222")

    assert store.get_task(task["id"])["linkedSessionIds"] == []


def test_database_task_store_verify_schema_rejects_missing_constraint(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path}/tasks.db"
    store = DatabaseTaskStore(database_url, create_schema=True)
    with store.engine.begin() as conn:
        conn.execute(text("DROP TABLE task_sessions"))
        conn.execute(
            text(
                """
                CREATE TABLE task_sessions (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at DATETIME NOT NULL
                )
                """
            )
        )

    with pytest.raises(RuntimeError, match="task_id, session_id"):
        store.verify_schema()
