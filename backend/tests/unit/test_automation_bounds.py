"""Automation ticks bound discovery without losing broadcast recipients."""

from datetime import UTC, datetime

from sqlalchemy import delete, select

from relay.automations.service import AutomationService
from relay.persistence.automation.store import DatabaseAutomationStore, insert_outbox_rows
from relay.persistence.tables.automations import automation_outbox
from store_fixtures import make_session_store, make_task_store, sqlite_url


NOW = datetime(2026, 11, 6, 12, tzinfo=UTC)
ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


def world(tmp_path, *, batch=2):
    tasks, sessions = make_task_store(tmp_path), make_session_store(tmp_path)
    store = DatabaseAutomationStore(sqlite_url(tmp_path), create_schema=True)
    service = AutomationService(
        task_store=tasks, session_store=sessions, automation_store=store, project_store=None, batch=batch
    )
    return tasks, sessions, store, service


def routine(tasks, *, triggers=None):
    return tasks.create_task(
        {
            "title": "Triage",
            "isRoutine": True,
            "routineState": "active",
            "assignedAgent": "codex",
            "assignedAgentId": "agent_1",
            "routineTriggers": [ON_BLOCKED] if triggers is None else triggers,
        }
    )


def broadcast(store):
    with store.engine.begin() as conn:
        conn.execute(delete(automation_outbox))
        insert_outbox_rows(
            conn,
            [
                {
                    "kind": "task_event",
                    "event_type": "task.status_changed",
                    "payload": {"subject": {"status": "blocked"}, "to": "blocked"},
                    "depth": 0,
                }
            ],
        )


def test_targeted_work_never_reads_the_automation_catalog(tmp_path, monkeypatch):
    tasks, _, store, service = world(tmp_path)
    target = routine(tasks, triggers=[])
    store.enqueue_manual(target["id"])

    def forbidden():
        raise AssertionError("targeted work must not scan the catalog")

    monkeypatch.setattr(tasks, "list_trigger_automations", forbidden)
    assert service.tick(NOW) == 1
    assert len(tasks.get_task(target["id"])["occurrenceIds"]) == 1


def test_broadcast_pages_survive_service_restarts_and_never_fire_twice(tmp_path):
    tasks, sessions, store, service = world(tmp_path)
    ids = [routine(tasks)["id"] for _ in range(7)]
    broadcast(store)
    totals = []
    for _ in range(5):
        totals.append(service.tick(NOW))
        service = AutomationService(
            task_store=tasks, session_store=sessions, automation_store=store, project_store=None, batch=2
        )
    assert max(totals) <= 2, "one broadcast must not process the whole fleet in one tick"
    assert sum(totals) == 7
    assert all(len(tasks.get_task(record_id)["occurrenceIds"]) == 1 for record_id in ids)
    with store.engine.connect() as conn:
        assert conn.scalar(select(automation_outbox.c.id)) is None


def test_pending_discovery_is_bounded_and_fair_across_replicas(tmp_path, monkeypatch):
    tasks, sessions, store, service = world(tmp_path)
    ids = []
    for _ in range(7):
        record = routine(tasks, triggers=[])
        ids.append(record["id"])
        tasks.create_triggered_occurrence(
            record["id"], run_date="2026-11-06", trigger_kind="manual", depth=0, context="", allow_paused=True
        )
        store.mark_pending(record["id"], {"eventType": "manual", "depth": 0}, NOW)
    with store.engine.begin() as conn:
        conn.execute(delete(automation_outbox))
    visits = []
    for _ in range(4):
        original = service.firing.fire_one
        current = []

        def observe(record_id, now, original=original, current=current):
            current.append(record_id)
            return original(record_id, now)

        monkeypatch.setattr(service.firing, "fire_one", observe)
        assert service.tick(NOW) == 0
        visits.extend(current)
        assert len(current) <= 2, "pending discovery must have a per-tick budget"
        service = AutomationService(
            task_store=tasks,
            session_store=sessions,
            automation_store=DatabaseAutomationStore(sqlite_url(tmp_path)),
            project_store=None,
            batch=2,
        )
    assert set(visits) == set(ids), "an in-flight routine must not starve later pending routines"


def test_tick_does_not_use_full_snapshot_discovery_queries(tmp_path, monkeypatch):
    tasks, _, store, service = world(tmp_path)
    routine(tasks)
    broadcast(store)

    def forbidden(*args):
        raise AssertionError("tick must discover bounded IDs and routing projections")

    for method in ("list_unseeded_schedules", "list_due_schedules", "list_trigger_automations"):
        monkeypatch.setattr(tasks, method, forbidden)
    monkeypatch.setattr(store, "list_pending_states", forbidden)
    assert service.tick(NOW) == 1


def test_failed_outer_commit_rolls_back_broadcast_progress(tmp_path, monkeypatch):
    tasks, _, store, service = world(tmp_path)
    ids = [routine(tasks)["id"] for _ in range(5)]
    broadcast(store)
    finish = service.matcher.finish

    def fail(*args):
        finish(*args)
        raise RuntimeError("injected final write failure")

    monkeypatch.setattr(service.matcher, "finish", fail)
    assert service.tick(NOW) == 0
    assert all(not tasks.get_task(record_id)["occurrenceIds"] for record_id in ids)
    monkeypatch.setattr(service.matcher, "finish", finish)
    totals = [service.tick(NOW) for _ in range(4)]
    assert sum(totals) == 5
    assert max(totals) <= 2
    assert all(len(tasks.get_task(record_id)["occurrenceIds"]) == 1 for record_id in ids)


def test_partial_broadcast_retries_only_failed_recipient(tmp_path, monkeypatch):
    tasks, _, store, service = world(tmp_path)
    ids = [routine(tasks)["id"] for _ in range(7)]
    broadcast(store)
    original = service.firing.fire_one
    failed = []

    def fail_once(record_id, now):
        if record_id == ids[0] and not failed:
            failed.append(record_id)
            raise RuntimeError("recipient unavailable")
        return original(record_id, now)

    monkeypatch.setattr(service.firing, "fire_one", fail_once)
    assert sum(service.tick(NOW) for _ in range(8)) == 7
    assert failed == [ids[0]]
    assert all(len(tasks.get_task(record_id)["occurrenceIds"]) == 1 for record_id in ids)


def test_broadcast_snapshot_excludes_routines_created_after_routing_starts(tmp_path):
    tasks, _, store, service = world(tmp_path)
    ids = [routine(tasks)["id"] for _ in range(5)]
    broadcast(store)
    assert service.tick(NOW) == 2
    later = routine(tasks)
    assert sum(service.tick(NOW) for _ in range(4)) == 3
    assert all(len(tasks.get_task(record_id)["occurrenceIds"]) == 1 for record_id in ids)
    assert not tasks.get_task(later["id"])["occurrenceIds"]


def test_routing_projections_are_bounded_and_tie_safe(tmp_path):
    from sqlalchemy import update
    from datetime import timedelta

    tasks, _, store, _ = world(tmp_path)
    ids = [routine(tasks)["id"] for _ in range(7)]
    with store.engine.begin() as conn:
        conn.execute(update(tasks.tasks).values(created_at=NOW))
    seen = []
    after = {}
    for _ in range(4):
        page = store.routing_page(limit=2, before=NOW + timedelta(seconds=1), **after)
        assert len(page) <= 2
        for record in page:
            assert set(record) == {"id", "createdAt", "ownerUserId", "routineTriggers", "isRoutine", "routineState"}
        seen.extend(record["id"] for record in page)
        if page:
            after = {"after_created_at": page[-1]["createdAt"], "after_id": page[-1]["id"]}
    assert seen == sorted(ids)


def test_standalone_drain_rolls_back_routing_and_pending_state(tmp_path, monkeypatch):
    import pytest

    tasks, _, store, service = world(tmp_path)
    ids = [routine(tasks)["id"] for _ in range(5)]
    broadcast(store)
    original = service.matcher.deliver

    def fail(record_id, deliveries, now):
        original(record_id, deliveries, now)
        raise RuntimeError("injected drain interruption")

    monkeypatch.setattr(service.matcher, "deliver", fail)
    with pytest.raises(RuntimeError, match="drain interruption"):
        service.matcher.drain(NOW)
    assert store.list_pending_states() == []
    with store.engine.connect() as conn:
        assert conn.scalar(select(automation_outbox.c.routing_after_id)) is None
    monkeypatch.setattr(service.matcher, "deliver", original)
    for _ in range(4):
        service.matcher.drain(NOW)
    assert {state["routine_id"] for state in store.list_pending_states()} == set(ids)
    assert all(len(state["pending_events"]) == 1 for state in store.list_pending_states())


def test_outbox_retention_deletes_a_bounded_page(tmp_path):
    from datetime import timedelta
    from sqlalchemy import insert, func

    _, _, store, _ = world(tmp_path)
    with store.engine.begin() as conn:
        conn.execute(
            insert(automation_outbox),
            [
                {"kind": "manual", "event_type": "manual", "payload": {}, "created_at": NOW - timedelta(days=8)}
                for _ in range(7)
            ],
        )
    assert store.prune_outbox(NOW - timedelta(days=7), limit=2) == 2
    with store.engine.connect() as conn:
        assert conn.scalar(select(func.count()).select_from(automation_outbox)) == 5


def test_multiple_broadcasts_share_the_routing_budget_and_all_recipients_progress(tmp_path):
    tasks, _, store, service = world(tmp_path)
    ids = [routine(tasks)["id"] for _ in range(5)]
    with store.engine.begin() as conn:
        insert_outbox_rows(conn, [
            {"kind": "task_event", "event_type": "task.status_changed", "depth": 0,
             "payload": {"subject": {"id": title, "title": title, "status": "blocked"}, "to": "blocked"}}
            for title in ("first", "second")
        ])
    for _ in range(10):
        service.tick(NOW)
    for record_id in ids:
        [occurrence_id] = tasks.get_task(record_id)["occurrenceIds"]
        occurrence = tasks.get_task(occurrence_id)
        state = store.get_state(record_id)
        assert occurrence["routineTriggerSummary"]["eventCount"] + len(state["pending_events"]) == 2
        titles = {event["subject"]["title"] for event in state["pending_events"]}
        titles.update(title for title in ("first", "second") if f'"{title}"' in occurrence["description"])
        assert titles == {"first", "second"}
    with store.engine.connect() as conn:
        assert conn.scalar(select(automation_outbox.c.id)) is None
