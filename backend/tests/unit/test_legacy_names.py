from relay.core.legacy_names import (
    LEGACY_KEYS,
    LEGACY_USER_DEVICE_LOCATION,
    contains_legacy_names,
    downgrade_to_legacy_names,
    upgrade_legacy_names,
)


def test_employee_keys_become_user_keys_at_every_depth() -> None:
    payload = {
        "employeeId": "alice",
        "ownerEmployeeId": "alice",
        "task": {"assigneeEmployeeId": "bob", "actor_employee_id": "carol"},
        "rows": [{"employees": [{"maxLocalComputersPerEmployee": 3}]}],
    }

    assert upgrade_legacy_names(payload) == {
        "userId": "alice",
        "ownerUserId": "alice",
        "task": {"assigneeUserId": "bob", "actor_user_id": "carol"},
        "rows": [{"users": [{"maxLocalComputersPerUser": 3}]}],
    }


def test_the_old_device_location_value_is_upgraded() -> None:
    node = {"nodeLocation": LEGACY_USER_DEVICE_LOCATION, "status": "ready"}

    assert upgrade_legacy_names(node) == {"nodeLocation": "user-device", "status": "ready"}


def test_legacy_enum_values_are_upgraded() -> None:
    assert upgrade_legacy_names({"workspacePolicy": {"kind": "employee-home"}}) == {
        "workspacePolicy": {"kind": "user-home"}
    }
    assert upgrade_legacy_names({"targetType": "employee", "targetId": "alice"}) == {
        "targetType": "user",
        "targetId": "alice",
    }
    assert contains_legacy_names({"assignment": {"target_type": "employee"}})


def test_the_word_employee_is_only_an_enum_under_a_target_type() -> None:
    event = {"role": "employee", "title": "employee"}

    assert upgrade_legacy_names(event) == event
    assert not contains_legacy_names(event)


def test_text_that_merely_mentions_an_employee_is_left_alone() -> None:
    event = {"type": "message", "text": "Ask the employee-device owner, employeeId alice"}

    assert upgrade_legacy_names(event) == event
    assert not contains_legacy_names(event)


def test_a_current_key_wins_over_its_legacy_twin() -> None:
    assert upgrade_legacy_names({"employeeId": "old", "userId": "new"}) == {"userId": "new"}
    assert upgrade_legacy_names({"userId": "new", "employeeId": "old"}) == {"userId": "new"}


def test_input_is_not_mutated() -> None:
    payload = {"employeeId": "alice", "nested": {"employeeId": "bob"}}

    upgrade_legacy_names(payload)

    assert payload == {"employeeId": "alice", "nested": {"employeeId": "bob"}}


def test_contains_legacy_names_finds_nested_keys_and_values() -> None:
    assert contains_legacy_names({"a": [{"ownerEmployeeId": "x"}]})
    assert contains_legacy_names({"a": {"nodeLocation": "employee-device"}})
    assert not contains_legacy_names({"a": [{"ownerUserId": "x"}]})


def test_downgrade_inverts_every_key_relay_wrote() -> None:
    legacy = {
        **{key: "alice" for key in LEGACY_KEYS},
        "nodeLocation": "employee-device",
        "assignment": {"targetType": "employee"},
        "policy": {"kind": "employee-home"},
    }

    assert downgrade_to_legacy_names(upgrade_legacy_names(legacy)) == legacy


def test_downgrade_leaves_keys_that_were_never_employee_keys() -> None:
    current = {"userCode": "ABCD", "username": "alice", "accountId": "a1"}

    assert downgrade_to_legacy_names(current) == current
