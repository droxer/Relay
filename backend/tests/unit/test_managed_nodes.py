from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from uuid import UUID

import pytest
import relay.services.managed_nodes as managed_nodes_module
from relay.services.managed_nodes import LocalManagedNodeStore


def test_managed_nodes_use_uuid_ids(tmp_path: Path) -> None:
    node = LocalManagedNodeStore(tmp_path).create_node({"employeeId": "alice"})

    assert str(UUID(node["id"])) == node["id"]


def test_managed_node_enrollment_grant_replays_completed_runtime(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice", "provider": "local-process"})
    attempt, credential = store.create_attempt(node["id"])

    enrolled_node, enrolled_attempt = store.consume_enrollment_grant(credential)
    store.complete_enrollment(node["id"], attempt["id"], "sbx_alice")
    store.complete_enrollment_grant(credential, "sbx_alice")

    assert enrolled_node["id"] == node["id"]
    assert enrolled_attempt["id"] == attempt["id"]
    replayed_node, replayed_attempt = store.consume_enrollment_grant(credential)
    assert replayed_node["id"] == node["id"]
    assert replayed_attempt["id"] == attempt["id"]


def test_purge_deleted_node_removes_its_history(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})
    attempt, _credential = store.create_attempt(node["id"])
    store.update_attempt(attempt["id"], {"status": "cancelled"})
    store.update_node(node["id"], {"desiredState": "deleted"})
    store.update_node(node["id"], {"phase": "deleted"})

    purged = store.purge_node(node["id"])

    assert purged["id"] == node["id"]
    assert store.get_node(node["id"]) is None
    assert store.list_attempts(node["id"]) == []
    assert list(store.grants_dir.glob("*.json")) == []


def test_provider_change_increments_generation_and_invalidates_old_grant(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice", "provider": "local-process"})
    _attempt, credential = store.create_attempt(node["id"])

    updated = store.update_node(node["id"], {"profile": "large"})

    assert updated["generation"] == 2
    with pytest.raises(PermissionError, match="no longer accepts"):
        store.consume_enrollment_grant(credential)


def test_employee_can_have_multiple_dedicated_managed_nodes(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    first = store.create_node({"employeeId": "alice"})
    second = store.create_node({"employeeId": "alice", "profile": "large"})

    assert first["id"] != second["id"]


def test_employee_cannot_have_two_running_nodes_in_the_same_policy_slot(
    tmp_path: Path,
) -> None:
    store = LocalManagedNodeStore(tmp_path)
    store.create_node({"employeeId": "alice"})

    with pytest.raises(ValueError, match="active managed node"):
        store.create_node({"employeeId": "alice"})


def test_stopped_node_cannot_restart_into_an_occupied_policy_slot(
    tmp_path: Path,
) -> None:
    store = LocalManagedNodeStore(tmp_path)
    stopped = store.create_node({"employeeId": "alice"})
    store.update_node(stopped["id"], {"desiredState": "stopped"})
    store.create_node({"employeeId": "alice"})

    with pytest.raises(ValueError, match="active managed node"):
        store.update_node(stopped["id"], {"desiredState": "running"})


def test_rejected_policy_slot_update_preserves_active_attempt(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    store.create_node({"employeeId": "alice"})
    large = store.create_node({"employeeId": "alice", "profile": "large"})
    attempt, _credential = store.create_attempt(large["id"])

    with pytest.raises(ValueError, match="active managed node"):
        store.update_node(large["id"], {"profile": "standard"})

    preserved = next(
        item
        for item in store.list_attempts(large["id"])
        if item["id"] == attempt["id"]
    )
    assert preserved["status"] == "pending"
    assert store.get_node(large["id"])["activeAttemptId"] == attempt["id"]


def test_policy_slot_uniqueness_is_enforced_across_store_instances(
    tmp_path: Path,
) -> None:
    stores = (LocalManagedNodeStore(tmp_path), LocalManagedNodeStore(tmp_path))
    barrier = Barrier(2)

    def create(store: LocalManagedNodeStore) -> str:
        barrier.wait()
        return store.create_node({"employeeId": "alice"})["id"]

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = [executor.submit(create, store) for store in stores]

    successes = [future.result() for future in results if future.exception() is None]
    failures = [future.exception() for future in results if future.exception() is not None]
    assert len(successes) == 1
    assert len(failures) == 1
    assert isinstance(failures[0], ValueError)


def test_managed_capacity_ensure_is_idempotent_across_store_instances(
    tmp_path: Path,
) -> None:
    stores = (LocalManagedNodeStore(tmp_path), LocalManagedNodeStore(tmp_path))
    barrier = Barrier(2)

    def ensure(store: LocalManagedNodeStore) -> tuple[str, bool]:
        barrier.wait()
        resolution = store.ensure_node_for_employee("alice")
        return resolution.node["id"], resolution.provisioning_requested

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(ensure, stores))

    assert len({node_id for node_id, _requested in results}) == 1
    assert sorted(requested for _node_id, requested in results) == [False, True]


def test_store_startup_reconciles_legacy_duplicate_active_policy_slots(
    tmp_path: Path,
) -> None:
    store = LocalManagedNodeStore(tmp_path)
    original = store.create_node(
        {"employeeId": "alice", "displayName": "Alice cloud computer"}
    )
    duplicate = {
        **original,
        "id": "00000000-0000-4000-8000-000000000002",
        "createdAt": "9999-01-01T00:00:01Z",
        "updatedAt": "9999-01-01T00:00:01Z",
    }
    store._write_node(duplicate)

    restarted = LocalManagedNodeStore(tmp_path)

    active = [
        node
        for node in restarted.list_nodes()
        if node["employeeId"] == "alice" and node["desiredState"] == "running"
    ]
    assert [node["id"] for node in active] == [original["id"]]
    reconciled = restarted.get_node(duplicate["id"])
    assert reconciled is not None
    assert reconciled["desiredState"] == "deleted"
    assert reconciled["phase"] == "deleting"


def test_store_startup_preserves_runtime_backed_duplicate_as_canonical(
    tmp_path: Path,
) -> None:
    store = LocalManagedNodeStore(tmp_path)
    pending = store.create_node({"employeeId": "alice"})
    runtime_backed = {
        **pending,
        "id": "00000000-0000-4000-8000-000000000003",
        "activeDaemonNodeId": "daemon-alice",
        "phase": "ready",
        "createdAt": "9999-01-01T00:00:01Z",
        "updatedAt": "9999-01-01T00:00:01Z",
    }
    store._write_node(runtime_backed)

    restarted = LocalManagedNodeStore(tmp_path)

    assert restarted.get_node(runtime_backed["id"])["desiredState"] == "running"
    assert restarted.get_node(pending["id"])["desiredState"] == "deleted"


def test_managed_node_employee_ids_are_normalized_before_slot_comparison(
    tmp_path: Path,
) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": " alice "})

    assert node["employeeId"] == "alice"
    with pytest.raises(ValueError, match="active managed node"):
        store.create_node({"employeeId": "alice"})


def test_managed_nodes_require_boxlite(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)

    with pytest.raises(ValueError, match="require sandboxMode boxlite"):
        store.create_node({"employeeId": "alice", "sandboxMode": "none"})


def test_managed_capacity_restart_is_reported_as_requested(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})
    stopped = store.update_node(node["id"], {"desiredState": "stopped"})

    resolution = store.ensure_node_for_employee("alice")

    assert resolution.provisioning_requested is True
    restarted = resolution.node
    assert restarted["id"] == node["id"]
    assert restarted["desiredState"] == "running"
    assert restarted["phase"] == "requested"
    assert restarted["generation"] == stopped["generation"] + 1


def test_restart_cancels_an_attempt_from_the_previous_generation(
    tmp_path: Path,
) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})
    old_attempt, _credential = store.create_attempt(node["id"])

    store.update_node(node["id"], {"desiredState": "stopped"})
    restarted = store.ensure_node_for_employee("alice").node
    new_attempt, _credential = store.create_attempt(restarted["id"])

    cancelled_attempt = next(
        attempt
        for attempt in store.list_attempts(node["id"])
        if attempt["id"] == old_attempt["id"]
    )
    assert cancelled_attempt["status"] == "cancelled"
    with pytest.raises(ValueError, match="already terminal"):
        store.update_attempt(old_attempt["id"], {"status": "allocating"})
    assert new_attempt["generation"] == restarted["generation"]


def test_running_managed_capacity_is_not_requested_twice(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})

    resolution = store.ensure_node_for_employee("alice")

    assert resolution.provisioning_requested is False
    existing = resolution.node
    assert existing["id"] == node["id"]


def test_running_managed_capacity_is_preferred_over_an_older_stopped_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    timestamps = iter(
        [
            "2026-07-19T00:00:00Z",
            "2026-07-19T00:00:01Z",
            "2026-07-19T00:00:02Z",
            "2026-07-19T00:00:03Z",
        ]
    )
    monkeypatch.setattr(managed_nodes_module, "now_iso", lambda: next(timestamps))
    store = LocalManagedNodeStore(tmp_path)
    stopped = store.create_node({"employeeId": "alice"})
    store.update_node(stopped["id"], {"desiredState": "stopped"})
    running = store.create_node({"employeeId": "alice"})

    resolution = store.ensure_node_for_employee("alice")

    assert resolution.provisioning_requested is False
    existing = resolution.node
    assert existing["id"] == running["id"]
    assert store.get_node(stopped["id"])["desiredState"] == "stopped"


def test_managed_capacity_resolution_matches_the_requested_policy_slot(
    tmp_path: Path,
) -> None:
    store = LocalManagedNodeStore(tmp_path)
    default = store.create_node({"employeeId": "alice"})
    store.update_node(default["id"], {"desiredState": "stopped"})
    large = store.create_node({"employeeId": "alice", "profile": "large"})

    resolution = store.ensure_node_for_employee(
        "alice", policy={"profile": "standard"}
    )

    assert resolution.node["id"] == default["id"]
    assert resolution.node["desiredState"] == "running"
    assert store.get_node(large["id"])["desiredState"] == "running"


def test_successful_enrollment_links_observed_daemon(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})
    attempt, credential = store.create_attempt(node["id"])
    store.consume_enrollment_grant(credential)

    updated, completed = store.complete_enrollment(node["id"], attempt["id"], "sbx_alice")
    store.complete_enrollment_grant(credential, "sbx_alice")

    assert completed["status"] == "succeeded"
    assert updated["activeDaemonNodeId"] == "sbx_alice"
    assert updated["phase"] == "registering"
    assert store.mark_ready("sbx_alice")["phase"] == "ready"


def test_repeated_failed_attempts_do_not_grow_history_without_bound(
    tmp_path: Path,
) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})

    for _ in range(managed_nodes_module.ATTEMPT_HISTORY_LIMIT + 10):
        attempt, _credential = store.create_attempt(node["id"])
        store.update_attempt(attempt["id"], {"status": "failed"})

    retained = store.list_attempts(node["id"])
    assert len(retained) <= managed_nodes_module.ATTEMPT_HISTORY_LIMIT + 1
    assert len(list(store.grants_dir.glob("*.json"))) <= len(retained)


def test_expired_grants_are_swept_when_new_attempts_are_created(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})
    expired, credential = store.create_attempt(node["id"], grant_ttl_seconds=-1)
    store.update_attempt(expired["id"], {"status": "failed"})

    store.create_attempt(node["id"])

    assert len(list(store.grants_dir.glob("*.json"))) == 1
    with pytest.raises(PermissionError, match="Invalid enrollment credential"):
        store.consume_enrollment_grant(credential)


def test_completed_grant_rejects_replay_after_attempt_is_cancelled(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})
    attempt, credential = store.create_attempt(node["id"])
    store.consume_enrollment_grant(credential)
    store.complete_enrollment_grant(credential, "sbx_alice")
    store.update_attempt(attempt["id"], {"status": "cancelled"})

    store.create_attempt(node["id"])

    with pytest.raises(PermissionError, match="not active"):
        store.consume_enrollment_grant(credential)


def test_blank_provider_is_rejected(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)

    with pytest.raises(ValueError, match="provider must be a non-empty string"):
        store.create_node({"employeeId": "alice", "provider": "   "})

    node = store.create_node({"employeeId": "alice"})
    with pytest.raises(ValueError, match="provider must be a non-empty string"):
        store.update_node(node["id"], {"provider": 7})


def test_late_provider_registration_preserves_completed_enrollment(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})
    attempt, _ = store.create_attempt(node["id"])
    store.complete_enrollment(node["id"], attempt["id"], "daemon")
    store.mark_ready("daemon")
    completed = store.list_attempts(node["id"])[0]
    updated = store.update_attempt(attempt["id"], {
        "status": "registering", "providerInstanceId": "instance",
    })
    assert updated["status"] == "succeeded"
    assert updated["providerInstanceId"] == "instance"
    assert updated["finishedAt"] == completed["finishedAt"]
    assert store.get_node(node["id"])["phase"] == "ready"


def test_old_runtime_cannot_mark_new_generation_ready(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})
    attempt, _ = store.create_attempt(node["id"])
    store.complete_enrollment(node["id"], attempt["id"], "daemon")
    store.update_node(node["id"], {"profile": "large"})
    assert store.mark_ready("daemon") is None
    assert store.get_node(node["id"])["phase"] == "requested"


def test_stopping_runtime_cannot_mark_ready(tmp_path: Path) -> None:
    store = LocalManagedNodeStore(tmp_path)
    node = store.create_node({"employeeId": "alice"})
    attempt, _ = store.create_attempt(node["id"])
    store.complete_enrollment(node["id"], attempt["id"], "daemon")
    store.update_node(node["id"], {"desiredState": "stopped"})
    assert store.mark_ready("daemon") is None
    assert store.get_node(node["id"])["phase"] == "draining"
