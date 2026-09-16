from concurrent.futures import ThreadPoolExecutor

import pytest
from relay.persistence.task_store import DatabaseTaskStore, LocalTaskStore
from relay.persistence.store_common import relay_task_event


@pytest.fixture(params=["local", "database"])
def store(request, tmp_path):
    if request.param == "local":
        return LocalTaskStore(tmp_path)
    return DatabaseTaskStore(f"sqlite:///{tmp_path}/flow.db", create_schema=True)


def status(store, task, value, **fields):
    return store.append_event(
        task["id"],
        relay_task_event("task.status", task["id"], {"status": value, **fields}),
    )


def test_blocking_preserves_stage_and_age_across_rework(store):
    task = store.create_task({"title": "Review delivery", "acceptancePolicy": "human"})
    task = status(store, task, "running")
    started = task["startedAt"]
    task = status(store, task, "review")
    task = status(
        store, task, "blocked", reason="Missing sign-off", actorEmployeeId="alice"
    )
    assert task["workflowStage"] == "review"
    assert task["blockedFromStatus"] == "review"
    assert task["blockerReason"] == "Missing sign-off"
    assert task["blockerOwnerEmployeeId"] == "alice"
    assert task["blockedAt"]
    assert "finishedAt" not in task
    task = status(store, task, "review")
    assert "blockedAt" not in task
    task = status(store, task, "assigned")
    assert task["workflowStage"] == "running"
    assert task["startedAt"] == started
    task = status(store, task, "done")
    assert task["finishedAt"]
    task = status(store, task, "assigned")
    assert task["startedAt"] == started
    assert "finishedAt" not in task


def test_acceptance_policy_survives_events_and_routine_occurrences(store):
    task = store.create_task(
        {
            "title": "Routine",
            "acceptancePolicy": "human",
            "isRoutine": True,
            "routineEnabled": True,
            "routineNextRunDate": "2026-09-13",
            "assignedAgent": "codex",
        }
    )
    occurrence = store.promote_due_routine(task["id"], "2026-09-13", "2026-09-14")
    assert occurrence["acceptancePolicy"] == "human"
    task = store.update_task(task["id"], {"acceptancePolicy": "automatic"})
    assert task["acceptancePolicy"] == "automatic"


def claim(store, task):
    return store.append_event(
        task["id"],
        relay_task_event(
            "task.execution.claimed",
            task["id"],
            {
                "requestId": task["id"],
                "expectedRevision": 0,
            },
        ),
    )


def test_wip_admission_counts_review_waiting_and_blocked_but_not_ready(
    store, monkeypatch
):
    monkeypatch.setenv("RELAY_TASK_WIP_LIMIT", "1")
    first = store.create_task({"title": "First", "ownerEmployeeId": "alice"})
    second = store.create_task({"title": "Second", "ownerEmployeeId": "alice"})
    claimed = claim(store, first)
    assert claimed["startedAt"]
    for state in ["review", "waiting_for_human", "blocked", "assigned"]:
        status(store, first, state)
        with pytest.raises(ValueError, match="task_wip_limit"):
            claim(store, second)
    # Continuations do not consume a second slot.
    store.append_event(
        first["id"],
        relay_task_event(
            "task.execution.claimed",
            first["id"],
            {
                "requestId": "continuation",
                "expectedRevision": 1,
            },
        ),
    )
    status(store, first, "done")
    assert claim(store, second)["startedAt"]
    other = store.create_task({"title": "Other employee", "ownerEmployeeId": "bob"})
    assert claim(store, other)["startedAt"]


def test_execution_claim_stays_ready_until_an_agent_starts(store):
    task = store.create_task({"title": "Wait for the daemon", "status": "assigned"})

    admitted = claim(store, task)

    assert admitted["status"] == "assigned"
    assert admitted["workflowStage"] == "assigned"
    assert admitted["startedAt"]

    executing = status(store, admitted, "running")
    assert executing["workflowStage"] == "running"


def test_concurrent_wip_admission_is_atomic(tmp_path, monkeypatch):
    monkeypatch.setenv("RELAY_TASK_WIP_LIMIT", "1")
    url = f"sqlite:///{tmp_path}/concurrent.db"
    store = DatabaseTaskStore(url, create_schema=True)
    tasks = [
        store.create_task({"title": str(i), "ownerEmployeeId": "alice"})
        for i in range(4)
    ]

    def attempt(task):
        try:
            claim(DatabaseTaskStore(url), task)
            return True
        except ValueError as error:
            assert "task_wip_limit" in str(error)
            return False

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sum(pool.map(attempt, tasks)) == 1


def test_legacy_events_keep_automatic_acceptance():
    from relay.persistence.store_common import materialize_task_events

    task = materialize_task_events(
        [relay_task_event("task.created", "legacy", {"title": "Historical"})]
    )
    assert task["acceptancePolicy"] == "automatic"
    assert task["workflowStage"] == "backlog"


def test_ready_backlog_and_templates_do_not_consume_wip(store, monkeypatch):
    monkeypatch.setenv("RELAY_TASK_WIP_LIMIT", "1")
    store.create_task({"title": "Template", "isRoutine": True, "status": "review"})
    store.create_task({"title": "Ready", "status": "assigned"})
    store.create_task({"title": "Backlog"})
    task = store.create_task({"title": "Work"})
    assert claim(store, task)["startedAt"]


def test_limit_must_be_positive(monkeypatch):
    from relay.persistence.task_lifecycle import wip_limit

    monkeypatch.setenv("RELAY_TASK_WIP_LIMIT", "0")
    with pytest.raises(ValueError, match="positive integer"):
        wip_limit()


def test_stale_manual_transition_does_not_overwrite_a_new_execution(store):
    task = store.create_task({"title": "Work"})
    claim(store, task)
    with pytest.raises(ValueError, match="task_state_changed"):
        store.update_task_if_not_dispatching(
            task["id"],
            {
                "status": "blocked",
                "expectedStatus": "backlog",
                "expectedExecutionRevision": 0,
            },
        )
    assert store.get_task(task["id"])["status"] == "assigned"


def test_reopening_finished_execution_requires_capacity(store, monkeypatch):
    monkeypatch.setenv("RELAY_TASK_WIP_LIMIT", "1")
    old = store.create_task({"title": "Old"})
    claim(store, old)
    status(store, old, "done")
    active = store.create_task({"title": "Active"})
    claim(store, active)
    with pytest.raises(ValueError, match="task_wip_limit"):
        store.append_event(
            old["id"],
            relay_task_event(
                "task.execution.claimed",
                old["id"],
                {
                    "requestId": "reopen",
                    "expectedRevision": 1,
                },
            ),
        )


def test_prepared_start_cannot_overwrite_a_new_block(store):
    task = store.create_task({"title": "Work"})
    status(store, task, "blocked")
    with pytest.raises(ValueError, match="task_ownership_changed"):
        store.append_event(
            task["id"],
            relay_task_event(
                "task.execution.claimed",
                task["id"],
                {
                    "requestId": "prepared",
                    "expectedRevision": 0,
                    "expectedStatus": "backlog",
                },
            ),
        )
