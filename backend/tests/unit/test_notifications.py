"""In-app notifications: which changes become notices, for whom, and once."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from relay.daemon_registry.client_version import client_outdated, missing_capabilities
from relay.daemon_registry.registry import DAEMON_NODE_CAPABILITIES
from relay.notifications.rules import (
    CLIENT_OUTDATED,
    COMPUTER_STATUS,
    TASK_COMPLETED,
    task_completion,
    task_notification_rows,
    task_recipients,
)
from relay.notifications.watcher import ComputerNotificationWatcher
from relay.persistence.notification_store import DatabaseNotificationStore
from relay.persistence.task_store import DatabaseTaskStore

SEEN = "2026-10-16T12:00:00Z"


def _store(tmp_path: Path) -> DatabaseNotificationStore:
    return DatabaseNotificationStore(f"sqlite:///{tmp_path}/relay.db", create_schema=True)


# --- rules -----------------------------------------------------------------


def test_entering_review_or_finishing_outright_is_a_completion() -> None:
    assert task_completion({"status": "running"}, {"id": "t", "status": "review"}) == "review"
    assert task_completion({"status": "running"}, {"id": "t", "status": "done"}) == "done"


def test_accepting_a_reviewed_task_is_not_news_to_the_person_who_accepted_it() -> None:
    assert task_completion({"status": "review"}, {"id": "t", "status": "done"}) is None


def test_creation_edits_routines_and_deletions_never_notify() -> None:
    assert task_completion(None, {"id": "t", "status": "done"}) is None
    assert task_completion({"status": "review"}, {"id": "t", "status": "review"}) is None
    assert task_completion({"status": "running"}, {"id": "t", "status": "review", "isRoutine": True}) is None
    assert task_completion({"status": "running"}, {"id": "t", "status": "done", "deletedAt": SEEN}) is None


def test_a_routine_occurrence_notifies_only_when_it_waits_for_review() -> None:
    occurrence = {"id": "t", "sourceRoutineId": "r-1"}
    assert task_completion({"status": "running"}, {**occurrence, "status": "done"}) is None
    assert task_completion({"status": "running"}, {**occurrence, "status": "review"}) == "review"


def test_owner_and_human_assignee_each_get_one_notice() -> None:
    assert task_recipients({"ownerUserId": "u-1", "assigneeUserId": "u-1"}) == ["u-1"]
    assert task_recipients({"ownerUserId": "u-1", "assigneeUserId": "u-2"}) == ["u-1", "u-2"]
    assert task_recipients({}) == []


def test_whoever_finished_the_task_themself_gets_no_notice() -> None:
    after = {"id": "t-1", "status": "done", "ownerUserId": "u-1", "assigneeUserId": "u-2"}
    events = [{"type": "task.status", "status": "done", "actorUserId": "u-2"}]

    rows = task_notification_rows({"status": "running"}, after, events)

    assert [row["user_id"] for row in rows] == ["u-1"]


def test_task_notice_carries_facts_not_prose() -> None:
    after = {"id": "t-1", "title": "Ship it", "status": "review", "number": 12,
             "projectId": "p-1", "ownerUserId": "u-1"}

    [row] = task_notification_rows({"status": "running"}, after)

    assert row == {"user_id": "u-1", "kind": TASK_COMPLETED, "data": {
        "taskId": "t-1", "title": "Ship it", "status": "review", "number": 12, "projectId": "p-1",
    }}


# --- client version ----------------------------------------------------------


def test_a_computer_missing_a_known_capability_runs_an_outdated_client() -> None:
    current = {"lastSeenAt": SEEN, "capabilities": sorted(DAEMON_NODE_CAPABILITIES)}
    old = {"lastSeenAt": SEEN, "capabilities": sorted(DAEMON_NODE_CAPABILITIES - {"agent-resume"})}

    assert not client_outdated(current)
    assert missing_capabilities(old) == ["agent-resume"]


def test_a_computer_that_never_registered_is_not_outdated() -> None:
    assert not client_outdated({"capabilities": []})


# --- store -------------------------------------------------------------------


def test_task_store_writes_the_notice_with_the_status_change(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/relay.db"
    tasks = DatabaseTaskStore(url, create_schema=True)
    notices = DatabaseNotificationStore(url)
    tasks.emit_automation_events = False  # Notices do not ride on automations.
    task = tasks.create_task({"title": "Import", "ownerUserId": "u-1"})

    tasks.update_task(task["id"], {"status": "review"})
    tasks.update_task(task["id"], {"title": "Import v2"})

    inbox = notices.list_for_user("u-1")
    assert inbox["unreadCount"] == 1
    assert inbox["notifications"][0]["data"]["taskId"] == task["id"]
    assert notices.list_for_user("u-2")["notifications"] == []


def test_mark_read_touches_only_the_callers_notices(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.add([{"user_id": "u-1", "kind": TASK_COMPLETED, "data": {}},
               {"user_id": "u-2", "kind": TASK_COMPLETED, "data": {}}])
    theirs = store.list_for_user("u-2")["notifications"][0]["id"]

    store.mark_read("u-1", [theirs, "not-a-uuid"])
    assert store.list_for_user("u-2")["unreadCount"] == 1

    store.mark_read("u-1", None)
    inbox = store.list_for_user("u-1")
    assert inbox["unreadCount"] == 0
    assert inbox["notifications"][0]["readAt"].endswith("Z")


def test_muting_a_kind_hides_it_and_unmuting_brings_it_back(tmp_path: Path) -> None:
    store = _store(tmp_path)
    store.add([{"user_id": "u-1", "kind": COMPUTER_STATUS, "data": {}},
               {"user_id": "u-1", "kind": TASK_COMPLETED, "data": {}}])

    store.set_muted_kinds("u-1", [COMPUTER_STATUS])
    muted = store.list_for_user("u-1")
    store.set_muted_kinds("u-1", [])

    assert [item["kind"] for item in muted["notifications"]] == [TASK_COMPLETED]
    assert muted["unreadCount"] == 1
    assert store.list_for_user("u-1")["unreadCount"] == 2


def test_preferences_save_handles_a_competing_first_insert(tmp_path: Path) -> None:
    from datetime import datetime, timezone

    from sqlalchemy import event, insert

    from relay.persistence.notification_store import notification_preferences

    store = _store(tmp_path)
    competing = True

    def insert_competitor(conn, cursor, statement, parameters, context, executemany):
        nonlocal competing
        if competing and statement.startswith("INSERT INTO notification_preferences"):
            # Model another writer winning the first insert before ours executes.
            competing = False
            conn.execute(insert(notification_preferences).values(
                user_id="u-1", muted_kinds=[TASK_COMPLETED], updated_at=datetime.now(timezone.utc),
            ))

    event.listen(store.engine, "before_cursor_execute", insert_competitor)
    try:
        assert store.set_muted_kinds("u-1", [COMPUTER_STATUS]) == [COMPUTER_STATUS]
    finally:
        event.remove(store.engine, "before_cursor_execute", insert_competitor)
    assert not competing
    assert store.muted_kinds("u-1") == [COMPUTER_STATUS]


def test_a_transition_is_claimed_once(tmp_path: Path) -> None:
    store = _store(tmp_path)
    row = {"user_id": "u-1", "kind": COMPUTER_STATUS, "data": {}}

    assert store.claim_transition("computer-online:n", None, "online", [])
    assert not store.claim_transition("computer-online:n", None, "online", [row])
    assert store.claim_transition("computer-online:n", "online", "offline", [row])
    assert not store.claim_transition("computer-online:n", "online", "offline", [row])
    assert store.list_for_user("u-1")["unreadCount"] == 1


# --- watcher -----------------------------------------------------------------


class FakeRegistry:
    def __init__(self, nodes: list[dict[str, Any]]) -> None:
        self.nodes = nodes

    def monitor_nodes(self) -> list[dict[str, Any]]:
        return self.nodes


class FakeAuth:
    def list_accounts(self) -> list[dict[str, Any]]:
        return [
            {"id": "a-1", "role": "admin", "userId": "admin-user"},
            {"id": "a-2", "role": "admin", "userId": None},
            {"id": "a-3", "role": "user", "userId": "u-9"},
        ]


def _node(**fields: Any) -> dict[str, Any]:
    return {"id": "n-1", "displayName": "Studio Mac", "userId": "u-1", "status": "ready",
            "online": True, "lastSeenAt": SEEN, "capabilities": sorted(DAEMON_NODE_CAPABILITIES),
            **fields}


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _watcher(store: DatabaseNotificationStore, registry: FakeRegistry, **options: Any) -> ComputerNotificationWatcher:
    return ComputerNotificationWatcher(registry, FakeAuth(), store, **{"offline_confirm_seconds": 0, **options})


def _kinds(store: DatabaseNotificationStore, user_id: str) -> list[str]:
    return [item["kind"] for item in store.list_for_user(user_id)["notifications"]]


def test_first_sighting_is_quiet_and_each_transition_notifies_once(tmp_path: Path) -> None:
    store = _store(tmp_path)
    registry = FakeRegistry([_node()])
    watcher = _watcher(store, registry)

    watcher.tick()
    assert _kinds(store, "u-1") == []

    registry.nodes = [_node(online=False)]
    watcher.tick()
    watcher.tick()
    registry.nodes = [_node()]
    watcher.tick()

    notices = store.list_for_user("u-1")["notifications"]
    assert sorted((item["data"]["from"], item["data"]["to"]) for item in notices) == [
        ("offline", "online"), ("online", "offline"),
    ]
    assert notices[0]["data"]["computerName"] == "Studio Mac"


def test_an_outdated_client_is_announced_on_first_sighting_and_once(tmp_path: Path) -> None:
    store = _store(tmp_path)
    old = sorted(DAEMON_NODE_CAPABILITIES - {"agent-resume"})
    registry = FakeRegistry([_node(capabilities=old)])
    watcher = _watcher(store, registry)

    watcher.tick()
    watcher.tick()

    [notice] = store.list_for_user("u-1")["notifications"]
    assert notice["kind"] == CLIENT_OUTDATED
    assert notice["data"]["missingCapabilities"] == ["agent-resume"]

    registry.nodes = [_node()]  # Updated: no notice for catching up.
    watcher.tick()
    registry.nodes = [_node(capabilities=old)]
    watcher.tick()
    assert _kinds(store, "u-1") == [CLIENT_OUTDATED, CLIENT_OUTDATED]


def test_offline_is_announced_only_once_it_lasts(tmp_path: Path) -> None:
    store = _store(tmp_path)
    clock = FakeClock()
    registry = FakeRegistry([_node()])
    watcher = _watcher(store, registry, offline_confirm_seconds=60, clock=clock)
    watcher.tick()

    # A blip (or every daemon reconnecting after a backend restart) is quiet.
    registry.nodes = [_node(online=False)]
    watcher.tick()
    clock.now = 30
    registry.nodes = [_node()]
    watcher.tick()
    assert _kinds(store, "u-1") == []

    registry.nodes = [_node(online=False)]
    clock.now = 40
    watcher.tick()
    clock.now = 99
    watcher.tick()
    assert _kinds(store, "u-1") == []
    clock.now = 100
    watcher.tick()
    assert _kinds(store, "u-1") == [COMPUTER_STATUS]


def test_replicas_that_know_different_capabilities_do_not_repeat_the_notice(tmp_path: Path) -> None:
    store = _store(tmp_path)
    old = sorted(DAEMON_NODE_CAPABILITIES - {"agent-resume"})
    registry = FakeRegistry([_node(capabilities=old)])
    upgraded = _watcher(store, registry)
    lagging = _watcher(store, registry, known_capabilities=frozenset(old))

    for _ in range(3):
        upgraded.tick()
        lagging.tick()

    assert _kinds(store, "u-1") == [CLIENT_OUTDATED]
    assert store.watch_states("client-outdated:") == {"client-outdated:n-1": "outdated:agent-resume"}


def test_shared_hardware_notifies_every_admin(tmp_path: Path) -> None:
    store = _store(tmp_path)
    registry = FakeRegistry([_node(userId=None)])
    watcher = _watcher(store, registry)
    watcher.tick()

    registry.nodes = [_node(userId=None, status="stopped")]
    watcher.tick()

    assert _kinds(store, "admin-user") == [COMPUTER_STATUS]
    assert _kinds(store, "a-2") == [COMPUTER_STATUS]  # An admin with no User.
    assert _kinds(store, "u-9") == []


def test_unregistered_and_vanished_computers_leave_no_watch_state(tmp_path: Path) -> None:
    store = _store(tmp_path)
    registry = FakeRegistry([_node(), _node(id="n-2", lastSeenAt=None)])
    watcher = _watcher(store, registry)

    watcher.tick()
    assert set(store.watch_states("computer-online:")) == {"computer-online:n-1"}

    registry.nodes = []
    watcher.tick()
    assert store.watch_states("computer-online:") == {}
    assert store.watch_states("client-outdated:") == {}
