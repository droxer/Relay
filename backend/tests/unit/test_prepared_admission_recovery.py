"""Recovery must not settle a follow-up while admission reopens its Thread."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.sessions.controller import SessionController
from store_fixtures import make_auth_store, make_daemon_store, make_session_store
from user_ids import user_id


def test_prepared_recovery_waits_for_followup_admission(tmp_path):
    sessions = make_session_store(str(tmp_path))
    daemons = make_daemon_store(str(tmp_path))
    make_auth_store(str(tmp_path)).ensure_user("alice")
    registry = DaemonNodeRegistry(sessions, daemons)
    registry.register({
        "sandboxId": "node", "userId": user_id("alice"), "token": "node-token",
        "workspacePath": "/workspace", "status": "ready",
        "supportedAgents": ["codex"], "protocolVersion": 1,
        "capabilities": ["workspace-scope", "thread-workspaces"],
    }, "ui-token")
    session = sessions.create_session({"workspacePath": "/workspace", "taskGoal": "First turn"})
    controller = SessionController(sessions)
    controller.complete_session(session["id"], "First turn finished")
    entered = Event()

    def recover(request):
        entered.set()
        registry._recover_prepared_request(request)

    with ThreadPoolExecutor(max_workers=1) as executor:
        with registry.dispatch_lock, registry.dispatch_scope(["node"]):
            request = registry.prepare_run_request(
                "node", session["id"], "Follow up",
                [{"executorKind": "codex", "mode": "action"}], {},
            )
            pending = executor.submit(recover, request)
            assert entered.wait(timeout=5)
            # The previous turn is still terminal until admission records the
            # new user contribution. Recovery must wait for that mutation.
            with pytest.raises(TimeoutError):
                pending.result(timeout=0.1)
            controller.record_user_message(session["id"], "Follow up")
            controller.continue_session(session["id"])
            registry.activate_run_request(request["id"])
        pending.result(timeout=5)

    current = daemons.get_run_request(request["id"])
    assert current["status"] == "running"
    assert current["currentCommandId"]
    assert len(registry.take_commands("node", "node-token")) == 1
