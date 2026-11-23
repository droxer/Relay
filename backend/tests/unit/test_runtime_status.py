from relay.core.runtime_status import executor_not_ready_message
from relay.daemon_registry.records import agent_registration_state, public_sandbox_record


def test_registration_keeps_why_a_runtime_is_not_ready() -> None:
    agents, details = agent_registration_state(
        {
            "supportedAgents": ["pi"],
            "agentHealth": {
                "claude": {"status": "failed", "detail": "Claude Code is not logged in."},
                "pi": {"status": "ready"},
                "codex": {"status": "unavailable", "detail": "Codex is not installed."},
                "opencode": {"status": "unresponsive", "detail": "OpenCode is not responding."},
            },
        }
    )

    assert agents == {
        "claude": "failed",
        "pi": "ready",
        "codex": "unavailable",
        "opencode": "unresponsive",
        "antigravity": "unknown",
    }
    assert details["codex"]["detail"] == "Codex is not installed."


def test_registration_reads_an_unrecognized_status_as_unknown() -> None:
    agents, _ = agent_registration_state(
        {"agentHealth": {"codex": {"status": "exploded"}}}
    )

    assert agents["codex"] == "unknown"


def test_computer_view_filters_retired_runtime_inventory_in_old_snapshots() -> None:
    old_snapshot = {
        "agents": {"codex": "ready", "kimi": "ready"},
        "agentModels": {"kimi": ["legacy-model"]},
        "disabledAgents": ["kimi", "pi"],
        "executorCapabilities": [{"executorKind": "kimi"}, {"executorKind": "codex"}],
    }
    assert public_sandbox_record(old_snapshot) == {
        "agents": {"codex": "ready"},
        "agentModels": {},
        "disabledAgents": ["pi"],
        "executorCapabilities": [{"executorKind": "codex"}],
    }
    assert old_snapshot["agents"]["kimi"] == "ready"


def test_executor_capabilities_win_over_legacy_health() -> None:
    agents, _ = agent_registration_state(
        {
            "executorCapabilities": [{"executorKind": "codex", "status": "unavailable"}],
            "agentHealth": {"codex": {"status": "failed"}},
        }
    )

    assert agents["codex"] == "unavailable"


def test_not_ready_message_names_the_reason() -> None:
    assert executor_not_ready_message("codex", "unavailable") == (
        "codex is not ready on this runtime node: it is not installed."
    )
    assert executor_not_ready_message("opencode", "unresponsive", prefix="Executor ") == (
        "Executor opencode is not ready on this runtime node: it stopped responding."
    )
    assert executor_not_ready_message("claude", "failed").endswith("its readiness check failed.")
    assert executor_not_ready_message("claude", "unknown") == (
        "claude is not ready on this runtime node."
    )
