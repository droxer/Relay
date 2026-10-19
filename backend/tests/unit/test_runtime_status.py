from relay.core.runtime_status import executor_not_ready_message
from relay.daemon_registry.records import agent_registration_state


def test_registration_keeps_why_a_runtime_is_not_ready() -> None:
    agents, details = agent_registration_state(
        {
            "supportedAgents": ["pi"],
            "agentHealth": {
                "claude": {"status": "failed", "detail": "Claude Code is not logged in."},
                "pi": {"status": "ready"},
                "codex": {"status": "unavailable", "detail": "Codex is not installed."},
                "kimi": {"status": "unresponsive", "detail": "Kimi is not responding."},
            },
        }
    )

    assert agents == {
        "claude": "failed",
        "pi": "ready",
        "codex": "unavailable",
        "kimi": "unresponsive",
    }
    assert details["codex"]["detail"] == "Codex is not installed."


def test_registration_reads_an_unrecognized_status_as_unknown() -> None:
    agents, _ = agent_registration_state(
        {"agentHealth": {"codex": {"status": "exploded"}}}
    )

    assert agents["codex"] == "unknown"


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
    assert executor_not_ready_message("kimi", "unresponsive", prefix="Executor ") == (
        "Executor kimi is not ready on this runtime node: it stopped responding."
    )
    assert executor_not_ready_message("claude", "failed").endswith("it failed to connect.")
    assert executor_not_ready_message("claude", "unknown") == (
        "claude is not ready on this runtime node."
    )
