from __future__ import annotations

from relay.core.computer_identity import computer_id, local_enrollment_key


def test_managed_node_wins_over_every_other_field() -> None:
    node = {
        "id": "node-1",
        "managedNodeId": "mnode-7",
        "userId": "alice",
        "workspaceId": "machine-a",
    }
    assert computer_id(node) == "managed:mnode-7"


def test_user_device_is_scoped_by_user_and_machine() -> None:
    node = {"id": "node-1", "userId": "alice", "workspaceId": "machine-a"}
    assert computer_id(node) == "device:alice:machine-a"


def test_workspace_path_does_not_take_part_in_identity() -> None:
    """workspaceId 是 machine-id；workspacePath 只是存储目录，不参与身份。"""
    one = {
        "id": "node-1",
        "userId": "alice",
        "workspaceId": "machine-a",
        "workspacePath": "/one",
    }
    two = {
        "id": "node-2",
        "userId": "alice",
        "workspaceId": "machine-a",
        "workspacePath": "/two",
    }
    assert computer_id(one) == computer_id(two)


def test_same_machine_two_users_are_two_computers() -> None:
    alice = {"id": "node-1", "userId": "alice", "workspaceId": "machine-a"}
    bob = {"id": "node-2", "userId": "bob", "workspaceId": "machine-a"}
    assert computer_id(alice) != computer_id(bob)


def test_same_user_two_daemons_on_one_machine_are_one_computer() -> None:
    first = {"id": "node-1", "userId": "alice", "workspaceId": "machine-a"}
    second = {"id": "node-2", "userId": "alice", "workspaceId": "machine-a"}
    assert computer_id(first) == computer_id(second)


def test_managed_and_device_namespaces_cannot_collide() -> None:
    managed = {"id": "node-1", "managedNodeId": "shared-value"}
    device = {"id": "node-2", "userId": "shared-value", "workspaceId": ""}
    assert computer_id(managed) != computer_id(device)


def test_falls_back_to_node_id_when_identity_is_unknown() -> None:
    assert computer_id({"id": "node-1"}) == "node:node-1"


def test_falls_back_to_node_id_when_machine_id_is_missing() -> None:
    assert computer_id({"id": "node-1", "userId": "alice"}) == "node:node-1"


def test_blank_values_do_not_produce_a_partial_identity() -> None:
    node = {"id": "node-1", "userId": "alice", "workspaceId": "   "}
    assert computer_id(node) == "node:node-1"


def test_local_enrollment_key_normalizes_the_workspace_path() -> None:
    assert local_enrollment_key("alice", "/Users/alice/tmp/../project") == (
        local_enrollment_key("alice", "/Users/alice/project")
    )


def test_local_enrollment_key_is_scoped_to_the_user() -> None:
    assert local_enrollment_key("alice", "/workspace") != local_enrollment_key(
        "bob", "/workspace"
    )
