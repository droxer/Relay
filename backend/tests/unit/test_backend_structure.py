from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from relay.api.helpers import daemon_node_event, token_usage_field
from relay.app import create_app
from relay.chat import DatabaseChatIntegrationStore
from relay.core.models import DaemonNodeRegistration
from relay.daemon_registry import DaemonNodeRegistry, ServerDaemonNodeBackend
from relay.persistence.daemon_store import (
    DatabaseDaemonStore,
)
from relay.persistence.daemon_store import (
    LocalDaemonStore as CanonicalLocalDaemonStore,
)
from relay.persistence.session_store import (
    DatabaseSessionStore,
    LocalSessionStore,
)
from relay.persistence.stores import LocalDaemonStore
from relay.persistence.task_store import (
    DatabaseTaskStore,
    LocalTaskStore,
)
from relay.security.auth import DatabaseUserAuthStore


def test_backend_container_runs_as_non_root_runtime_user() -> None:
    dockerfile = Path("backend/Dockerfile").read_text(encoding="utf-8")

    assert "USER relay" in dockerfile
    assert "useradd" in dockerfile


def test_devbox_dockerfile_inputs_are_available_in_build_context() -> None:
    dockerfile = Path("dockerfile").read_text(encoding="utf-8")
    dockerignore_patterns = {
        line.strip()
        for line in Path(".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }

    for source in ("devbox/claude-settings.json", "devbox/codex-config.toml"):
        assert f"COPY {source} " in dockerfile
        assert Path(source).is_file()
    assert "devbox/" not in dockerignore_patterns


def test_app_factory_wires_backend_state_and_routes() -> None:
    with TemporaryDirectory() as root:
        app = create_app(root)

    assert isinstance(app.state.session_store, DatabaseSessionStore)
    assert isinstance(app.state.task_store, DatabaseTaskStore)
    assert isinstance(app.state.daemon_store, LocalDaemonStore)
    assert app.state.task_scheduler is not None

    paths = {route.path for route in app.routes}
    assert "/api/v1/auth/login" in paths
    assert "/api/v1/admin/daemon-nodes" in paths
    assert "/api/v1/tasks/{task_id}/pickups" in paths
    assert "/api/v1/threads/{session_id}/events" in paths
    assert "/api/v1/daemon-nodes/{sandbox_id}/events" in paths


def test_app_factory_requires_database_for_thread_storage(monkeypatch) -> None:
    monkeypatch.delenv("RELAY_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with TemporaryDirectory() as root, pytest.raises(
        RuntimeError, match="database-only thread storage"
    ):
        create_app(root)


def test_app_factory_can_disable_task_scheduler(monkeypatch) -> None:
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    with TemporaryDirectory() as root:
        app = create_app(root)

    assert app.state.task_scheduler is None


def test_app_factory_uses_database_stores_without_local_state(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        database_url = f"sqlite:///{root}/relay.db"
        DatabaseSessionStore(database_url, create_schema=True)
        DatabaseTaskStore(database_url, create_schema=True)
        DatabaseDaemonStore(database_url, create_schema=True)
        DatabaseUserAuthStore(database_url, create_schema=True)
        DatabaseChatIntegrationStore(database_url, create_schema=True)
        monkeypatch.setenv("RELAY_STORAGE", "postgres")
        monkeypatch.setenv("RELAY_DATABASE_URL", database_url)
        monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
        app = create_app(root)

    assert isinstance(app.state.session_store, DatabaseSessionStore)
    assert isinstance(app.state.task_store, DatabaseTaskStore)
    assert isinstance(app.state.daemon_store, DatabaseDaemonStore)
    assert isinstance(app.state.auth_store, DatabaseUserAuthStore)
    assert isinstance(app.state.chat_store, DatabaseChatIntegrationStore)
    assert not hasattr(app.state.session_store, "root_dir")
    assert not hasattr(app.state.session_store, "artifacts_dir")


def test_backend_uses_canonical_domain_modules() -> None:
    assert CanonicalLocalDaemonStore is LocalDaemonStore
    assert LocalSessionStore.__module__ == "relay.persistence.session_store"
    assert LocalTaskStore.__module__ == "relay.persistence.task_store"
    assert DaemonNodeRegistration.__name__ == "DaemonNodeRegistration"
    assert DaemonNodeRegistry.__name__ == "DaemonNodeRegistry"
    assert ServerDaemonNodeBackend.__name__ == "ServerDaemonNodeBackend"
    assert DaemonNodeRegistry.__module__.startswith("relay.daemon_registry")
    assert ServerDaemonNodeBackend.__module__.startswith("relay.daemon_registry")


def test_daemon_node_event_parser_keeps_error_messages_and_raw_logs() -> None:
    raw_log = "  indented output\n\n"
    parsed = daemon_node_event(
        {
            "type": "run.completed",
            "commandId": "cmd_1",
            "sessionId": "ses_1",
            "runId": "run_1",
            "agent": "codex",
            "leaseId": "lease_1",
            "exitCode": 0,
            "agentLog": raw_log,
        }
    )

    assert parsed["exitCode"] == 0
    assert parsed["leaseId"] == "lease_1"
    assert parsed["agentLog"] == raw_log

    parsed_failed = daemon_node_event(
        {
            "type": "run.failed",
            "commandId": "cmd_1",
            "sessionId": "ses_1",
            "runId": "run_1",
            "agent": "codex",
            "error": "stream post failed",
            "agentLog": raw_log,
            "generatedFiles": [
                {
                    "relativePath": "agent-loop-guide.md",
                    "title": "agent-loop-guide.md",
                    "bytes": 13,
                    "contentType": "text/markdown",
                }
            ],
        }
    )
    assert parsed_failed["agentLog"] == raw_log
    assert parsed_failed["generatedFiles"][0]["relativePath"] == "agent-loop-guide.md"

    parsed_with_usage = daemon_node_event(
        {
            "type": "run.completed",
            "commandId": "cmd_1",
            "sessionId": "ses_1",
            "runId": "run_1",
            "agent": "codex",
            "exitCode": 0,
            "tokenUsage": {
                "input": 10,
                "output": 5,
                "cache": 3,
                "total": 18,
                "source": "codex",
            },
        }
    )
    # A daemon from before the cache split reports one combined figure; it
    # is read as cache reads.
    assert parsed_with_usage["tokenUsage"] == {
        "input": 10,
        "output": 5,
        "cache": 3,
        "cacheRead": 3,
        "cacheWrite": 0,
        "total": 18,
        "source": "codex",
    }

    split_usage = {"input": 10, "output": 5, "cache": 30, "cacheRead": 25, "cacheWrite": 5, "total": 45}
    for terminal in (
        {"type": "run.failed", "error": "stream post failed"},
        {"type": "run.cancelled", "reason": "Stopped.", "agentLog": raw_log},
    ):
        parsed_terminal = daemon_node_event(
            {
                **terminal,
                "commandId": "cmd_1",
                "sessionId": "ses_1",
                "runId": "run_1",
                "agent": "claude",
                "tokenUsage": split_usage,
            }
        )
        assert parsed_terminal["tokenUsage"] == split_usage
    assert parsed_terminal["agentLog"] == raw_log

    parsed_with_round_result = daemon_node_event(
        {
            "type": "run.completed",
            "commandId": "cmd_1",
            "sessionId": "ses_1",
            "runId": "run_1",
            "agent": "codex",
            "exitCode": 0,
            "roundResult": {"status": "done", "note": "all checks passed"},
        }
    )
    assert parsed_with_round_result["roundResult"] == {
        "status": "done",
        "note": "all checks passed",
    }

    # Token usage is telemetry hanging off a terminal event. Rejecting the
    # whole event over it would strand the run: the daemon drops the report,
    # the session stays "running", and — runs being exclusive — the node
    # refuses every later dispatch until the run timeout reaps it. Drop the
    # unusable counts and let the run finish.
    parsed_bad_usage = daemon_node_event(
        {
            "type": "run.completed",
            "commandId": "cmd_1",
            "sessionId": "ses_1",
            "runId": "run_1",
            "agent": "codex",
            "exitCode": 0,
            "agentLog": raw_log,
            "tokenUsage": {"input": 1, "output": 1, "cache": 0, "total": 9},
        }
    )
    assert "tokenUsage" not in parsed_bad_usage
    assert parsed_bad_usage["agentLog"] == raw_log

    with pytest.raises(ValueError, match="tokenUsage total"):
        token_usage_field(
            {"tokenUsage": {"input": 1, "output": 1, "cache": 0, "total": 9}}
        )
    with pytest.raises(ValueError, match="cacheRead"):
        token_usage_field(
            {"tokenUsage": {"input": 1, "output": 1, "cache": 9, "cacheRead": 1, "cacheWrite": 1}}
        )
