from datetime import datetime
from tempfile import TemporaryDirectory
from threading import RLock

import pytest
from relay.daemon_registry import DaemonNodeRegistry, ServerDaemonNodeBackend
from relay.persistence.daemon_store import DatabaseDaemonStore, LocalDaemonStore
from relay.persistence.session_store import LocalSessionStore
from relay.sessions import SessionController


def registration():
    return {
        "sandboxId": "node_stability",
        "employeeId": "alice",
        "token": "test-token",
        "protocolVersion": 1,
        "supportedAgents": ["codex"],
        "capabilities": ["thread-workspaces"],
        "status": "ready",
    }


class OrderedGlobalLock:
    """Fail an inverted acquisition instead of hanging the test process."""

    def __init__(self, registry):
        self.registry = registry
        self.lock = RLock()

    def __enter__(self):
        if not self.lock._is_owned():
            assert not any(
                entry.lock._is_owned()
                for entry in self.registry._dispatch_locks.values()
            ), "global lock acquired while holding a node lock"
        self.lock.acquire()
        return self

    def __exit__(self, *args):
        self.lock.release()


@pytest.mark.parametrize("continuation", [False, True])
def test_run_admission_obeys_terminal_event_lock_order(continuation):
    with TemporaryDirectory() as root:
        sessions = LocalSessionStore(root)
        registry = DaemonNodeRegistry(sessions, LocalDaemonStore(root))
        registry.register(registration())
        registry.dispatch_lock = OrderedGlobalLock(registry)
        request = {
            "taskGoal": "Check runtime stability",
            "assignments": [{"executorKind": "codex", "mode": "action"}],
        }
        if continuation:
            request["sessionId"] = SessionController(
                sessions, owner_employee_id="alice"
            ).create_session("Existing thread", ["human", "codex"])["id"]
        result = ServerDaemonNodeBackend(registry)._run_sync("node_stability", request)
        assert result["id"]
        assert len(registry.take_commands("node_stability", "test-token")) == 1


def test_direct_activation_obeys_terminal_event_lock_order():
    with TemporaryDirectory() as root:
        sessions = LocalSessionStore(root)
        registry = DaemonNodeRegistry(sessions, LocalDaemonStore(root))
        registry.register(registration())
        session = SessionController(sessions, owner_employee_id="alice").create_session(
            "Activate", ["human", "codex"]
        )
        request = registry.prepare_run_request(
            "node_stability",
            session["id"],
            "Activate",
            [{"executorKind": "codex", "mode": "action", "agentId": "logical"}],
            {},
        )
        registry.logical_assignment_validator = lambda assignment: (
            registry.monitor_nodes()
        )
        registry.dispatch_lock = OrderedGlobalLock(registry)
        registry.activate_run_request(request["id"])
        assert len(registry.take_commands("node_stability", "test-token")) == 1


def test_replica_refreshes_capabilities_without_a_newer_heartbeat():
    with TemporaryDirectory() as root:
        url = f"sqlite:///{root}/daemon.db"
        sessions = LocalSessionStore(root)
        first = DaemonNodeRegistry(
            sessions, DatabaseDaemonStore(url, create_schema=True)
        )
        first.register({**registration(), "supportedAgents": []})
        second = DaemonNodeRegistry(sessions, DatabaseDaemonStore(url))
        first.register(registration())
        # An unpersisted local heartbeat can be newer than the registration.
        second.sandboxes["node_stability"]["lastSeenAt"] = "2099-01-01T00:00:00Z"
        [node] = second.monitor_nodes()
        assert node["agents"]["codex"] == "ready"
        assert node["lastSeenAt"] == "2099-01-01T00:00:00Z"


@pytest.mark.parametrize("refresh_first", [False, True])
def test_stale_replica_registration_preserves_retirement(refresh_first):
    with TemporaryDirectory() as root:
        url = f"sqlite:///{root}/daemon.db"
        sessions = LocalSessionStore(root)
        first = DaemonNodeRegistry(
            sessions, DatabaseDaemonStore(url, create_schema=True)
        )
        first.register(registration())
        second = DaemonNodeRegistry(sessions, DatabaseDaemonStore(url))
        retired = first.fence_managed_node("node_stability")
        if refresh_first:
            second.monitor_nodes()
            assert second.get("node_stability")["retiredAt"] == retired["retiredAt"]
        registered = second.register(registration())
        assert registered["retiredAt"] == retired["retiredAt"]
        assert registered["status"] == "stopped"
        assert (
            first.daemon_store.get_node("node_stability")["retiredAt"]
            == retired["retiredAt"]
        )


@pytest.mark.parametrize(
    "factory",
    [
        LocalDaemonStore,
        lambda root: DatabaseDaemonStore(
            f"sqlite:///{root}/daemon.db", create_schema=True
        ),
    ],
)
@pytest.mark.parametrize("terminal_status", ["stopped", "deleted"])
def test_store_rejects_stale_registration_and_heartbeat_resurrection(
    factory, terminal_status
):
    with TemporaryDirectory() as root:
        store = factory(root)
        registry = DaemonNodeRegistry(LocalSessionStore(root), store)
        registry.register(registration())
        stale = store.get_node("node_stability")
        store.mark_node_seen(
            "node_stability",
            {"retiredAt": "2026-09-10T00:00:00Z", "status": terminal_status},
        )
        store.register_node(stale)
        store.mark_node_seen("node_stability", {"status": "ready"})
        node = store.get_node("node_stability")
        assert datetime.fromisoformat(node["retiredAt"].replace("Z", "+00:00")) == (
            datetime.fromisoformat("2026-09-10T00:00:00+00:00")
        )
        assert node["status"] == terminal_status
