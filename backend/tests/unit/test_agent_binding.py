from __future__ import annotations

from relay.services.agent_binding import binding_status


def _agent(**overrides) -> dict:
    return {
        "id": "agent-1",
        "supervisorUserId": "alice",
        "executorKind": "claude",
        "computerId": "device:alice:machine-a",
        **overrides,
    }


def _node(**overrides) -> dict:
    return {
        "id": "node-1",
        "userId": "alice",
        "workspaceId": "machine-a",
        "supportedAgents": ["claude"],
        "online": True,
        "stale": False,
        "status": "ready",
        **overrides,
    }


def test_available_when_the_computer_is_online_with_the_runtime() -> None:
    assert binding_status(_agent(), [_node()]) == "available"


def test_computer_gone_when_no_node_carries_that_identity() -> None:
    assert binding_status(_agent(), []) == "computer_gone"


def test_computer_offline_when_every_node_is_down() -> None:
    offline = _node(online=False, status="stopped")
    assert binding_status(_agent(), [offline]) == "computer_offline"


def test_runtime_missing_when_the_cli_is_gone() -> None:
    without = _node(supportedAgents=[])
    assert binding_status(_agent(), [without]) == "runtime_missing"


def test_runtime_missing_when_the_cli_is_disabled() -> None:
    disabled = _node(disabledAgents=["claude"])
    assert binding_status(_agent(), [disabled]) == "runtime_missing"


def test_agent_without_a_computer_id_is_computer_gone() -> None:
    assert binding_status(_agent(computerId=None), [_node()]) == "computer_gone"
