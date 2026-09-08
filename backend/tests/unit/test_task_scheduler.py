from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from relay.core.computer_identity import computer_id
from relay.daemon_registry import DaemonNodeRegistry, ServerDaemonNodeBackend
from relay.persistence.agent_placement_store import LocalAgentPlacementStore
from relay.persistence.daemon_store import LocalDaemonStore
from relay.persistence.employee_agent_store import LocalEmployeeAgentStore
from relay.persistence.session_store import LocalSessionStore
from relay.persistence.task_store import LocalTaskStore
from relay.persistence.team_store import LocalTeamStore
from relay.services.dispatch_retry import (
    MAX_DISPATCH_RETRY_DELAY_SECONDS,
    dispatch_retry_delay,
)
from relay.services.managed_nodes import LocalManagedNodeStore
from relay.tasks import (
    ROUTINE_SKIP_NO_AGENT_MESSAGE,
    SchedulerTickResult,
    TaskScheduler,
    materialize_legacy_agent_assignment,
    next_routine_date,
)


def _logical_backend(
    root: str,
    registry,
    *node_ids: str,
    instructions: str | None = None,
):
    agent_store = LocalEmployeeAgentStore(root)
    placement_store = LocalAgentPlacementStore(root)
    payload = {
        "displayName": "Builder",
        "executorKind": "codex",
        "defaultRole": "implementer",
    }
    if instructions:
        payload["instructions"] = instructions
    agent = agent_store.create_agent("alice", payload)
    for node_id in node_ids:
        placement_store.create_placement(agent, node_id)
    return (
        ServerDaemonNodeBackend(
            registry,
            employee_agent_store=agent_store,
            agent_placement_store=placement_store,
        ),
        agent,
    )


def test_scheduler_dispatches_assigned_task_to_ready_node() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            personality = "Be a careful release engineer who verifies every change."
            backend, agent = _logical_backend(
                root,
                registry,
                "sbx_alice",
                instructions=personality,
            )
            task = task_store.create_task(
                {
                    "title": "Ship scheduled backlog",
                    "description": "Run automatically.",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            )

            result = await scheduler.tick()

            assert result.dispatched == 1
            updated = task_store.get_task(task["id"])
            assert updated["status"] == "running"
            assert updated["linkedSessionIds"]
            [command] = registry.take_commands("sbx_alice", "node_token")
            assert command["type"] == "run.start"
            assert command["agent"] == "codex"
            assert command["taskGoal"] == "Ship scheduled backlog\n\nRun automatically."
            assert command["state"]["agent_instructions"] == personality
            assert command["delivery"]["type"] == "assignment-attempt"
            [session_id] = updated["linkedSessionIds"]
            [manifest] = session_store.get_session(session_id)["collaborationRounds"]
            assert manifest["source"] == "task"
            assert manifest["workGraph"]["items"][0]["ownerAgentId"] == agent["id"]

    asyncio.run(run_flow())


def test_scheduler_dispatches_the_task_layout_to_a_capable_node() -> None:
    """The scheduler resolves the run's workspace layout the same way
    ``TaskDispatcher`` does: against the node it actually dispatched to, not
    a hardcoded default. A node that advertises ``task-workspaces`` gets the
    task's durable per-task directory rather than the legacy per-thread one.
    """

    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces", "task-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            backend, agent = _logical_backend(root, registry, "sbx_alice")
            task = task_store.create_task(
                {
                    "title": "Ship scheduled backlog",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            )

            result = await scheduler.tick()

            assert result.dispatched == 1
            [command] = registry.take_commands("sbx_alice", "node_token")
            assert command["workspaceLayout"] == "task"
            assert command["workspaceSubpath"] == f"tasks/{task['id']}"

    asyncio.run(run_flow())


def test_scheduler_dispatches_when_employee_owns_multiple_computers() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            for suffix in ("one", "two"):
                registry.register(
                    {
                        "sandboxId": f"sbx_alice_{suffix}",
                        "employeeId": "alice",
                        "token": f"node_token_{suffix}",
                        "workspacePath": f"/workspace/alice/{suffix}",
                        "protocolVersion": 1,
                        "supportedAgents": ["codex"],
                        "capabilities": ["task-workspaces", "thread-workspaces"],
                        "status": "ready",
                    },
                    "ui_token",
                )
            backend, agent = _logical_backend(
                root, registry, "sbx_alice_one", "sbx_alice_two"
            )
            task = task_store.create_task(
                {
                    "title": "Runs on either computer",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            )

            result = await scheduler.tick()

            assert result.dispatched == 1
            assert task_store.get_task(task["id"])["status"] == "running"
            commands = [
                command
                for suffix in ("one", "two")
                for command in registry.take_commands(
                    f"sbx_alice_{suffix}", f"node_token_{suffix}"
                )
                if command["type"] == "run.start"
            ]
            assert len(commands) == 1

    asyncio.run(run_flow())


def test_scheduler_claim_fences_the_resolved_logical_assignment() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            backend, original_agent = _logical_backend(root, registry, "sbx_alice")
            replacement_agent = backend.agent_store.create_agent(
                "alice",
                {
                    "displayName": "Replacement",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                },
            )
            backend.agent_placement_store.create_placement(
                replacement_agent, "sbx_alice"
            )
            task = task_store.create_task(
                {
                    "title": "Fence the selected agent",
                    "assignedAgent": "codex",
                    "assignedAgentId": original_agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            original_claim = task_store.claim_task_for_dispatch

            def reassign_before_claim(
                task_id,
                agent,
                message=None,
                *,
                expected_assignment=None,
            ):
                task_store.update_task(
                    task_id,
                    {
                        "assignedAgent": "codex",
                        "assignedAgentId": replacement_agent["id"],
                        "assignedTeamId": None,
                    },
                )
                if expected_assignment is None:
                    return original_claim(task_id, agent, message)
                return original_claim(
                    task_id,
                    agent,
                    message,
                    expected_assignment=expected_assignment,
                )

            task_store.claim_task_for_dispatch = reassign_before_claim
            scheduler = TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            )

            result = await scheduler.tick()

            assert result.dispatched == 0
            assert registry.take_commands("sbx_alice", "node_token") == []
            updated = task_store.get_task(task["id"])
            assert updated["assignedAgentId"] == replacement_agent["id"]
            assert "dispatchClaim" not in updated

    asyncio.run(run_flow())


def test_scheduler_requests_managed_capacity_once_when_no_node_is_ready() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
            )
            managed_nodes = LocalManagedNodeStore(root)
            backend, agent = _logical_backend(root, registry)
            task_store.create_task(
                {
                    "title": "Needs managed capacity",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                managed_node_store=managed_nodes,
            )

            first = await scheduler.tick()
            second = await scheduler.tick()

            assert first.dispatched == 0
            assert first.skipped == 1
            assert second.dispatched == 0
            assert len(managed_nodes.list_nodes()) == 1
            [node] = managed_nodes.list_nodes()
            assert node["employeeId"] == "alice"
            assert node["desiredState"] == "running"

    asyncio.run(run_flow())


def test_scheduler_waits_for_an_employee_device_node_regardless_of_sandbox_mode() -> (
    None
):
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
            )
            registry.provision_pending(
                "alice",
                "/Users/alice/workspace",
                sandbox_mode="boxlite",
                node_location="employee-device",
            )
            managed_nodes = LocalManagedNodeStore(root)
            backend, agent = _logical_backend(root, registry)
            task_store.create_task(
                {
                    "title": "Wait for Alice's computer",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )

            await TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                managed_node_store=managed_nodes,
            ).tick()

            assert managed_nodes.list_nodes() == []

    asyncio.run(run_flow())


def test_scheduler_falls_back_to_managed_after_local_node_is_removed() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
            )
            local_node, _ui_token, _node_token = registry.provision_pending(
                "alice", "/Users/alice/workspace", sandbox_mode="none"
            )
            registry.delete(local_node["id"])
            managed_nodes = LocalManagedNodeStore(root)
            backend, agent = _logical_backend(root, registry)
            task_store.create_task(
                {
                    "title": "Continue after Alice disconnects local mode",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )

            await TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                managed_node_store=managed_nodes,
            ).tick()

            [managed] = managed_nodes.list_nodes()
            assert managed["employeeId"] == "alice"
            assert managed["desiredState"] == "running"

    asyncio.run(run_flow())


def test_scheduler_dispatches_task_by_logical_agent_placement() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            agent_store = LocalEmployeeAgentStore(root)
            placement_store = LocalAgentPlacementStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            backend = ServerDaemonNodeBackend(
                registry,
                employee_agent_store=agent_store,
                agent_placement_store=placement_store,
            )
            registry.register(
                {
                    "sandboxId": "node_builder",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            agent = agent_store.create_agent(
                "alice",
                {
                    "displayName": "Builder",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                },
            )
            placement_store.create_placement(agent, "node_builder")
            task = task_store.create_task(
                {
                    "title": "Ship with Builder",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )

            result = await TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            ).tick()

            assert result.dispatched == 1
            [command] = registry.take_commands("node_builder", "node_token")
            assert command["logicalAgentId"] == agent["id"]
            assert task_store.get_task(task["id"])["assignedAgentId"] == agent["id"]

    asyncio.run(run_flow())


def test_scheduler_promotes_due_routine_and_advances_next_run() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            backend, agent = _logical_backend(root, registry, "sbx_alice")
            routine = task_store.create_task(
                {
                    "title": "Weekly report",
                    "description": "Prepare the weekly status.",
                    "priority": "high",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "ownerEmployeeId": "alice",
                    "assigneeEmployeeId": "alice",
                    "isRoutine": True,
                    "routineType": "job",
                    "routineCadence": "weekly",
                    "routineNextRunDate": "2026-06-25",
                    "routineEnabled": True,
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                today=lambda: date(2026, 6, 25),
            )

            result = await scheduler.tick()

            assert result.promoted == 1
            assert result.dispatched == 1
            updated_routine = task_store.get_task(routine["id"])
            assert updated_routine["routineNextRunDate"] == "2026-07-02"
            occurrences = [
                task for task in task_store.list_tasks() if task["id"] != routine["id"]
            ]
            assert len(occurrences) == 1
            occurrence = occurrences[0]
            assert occurrence["title"] == "Weekly report"
            assert occurrence["priority"] == "high"
            assert occurrence["dueDate"] == "2026-06-25"
            assert occurrence["isRoutine"] is False
            assert occurrence["status"] == "running"
            assert occurrence["linkedSessionIds"]

    asyncio.run(run_flow())


def test_scheduler_dispatches_by_priority_not_recency() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            backend, agent = _logical_backend(root, registry, "sbx_alice")
            high = task_store.create_task(
                {
                    "title": "Older high priority",
                    "priority": "high",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            low = task_store.create_task(
                {
                    "title": "Newer low priority",
                    "priority": "low",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            )

            result = await scheduler.tick()

            # The node has one exclusive slot, so only the high-priority task
            # runs even though the low-priority one was touched more recently.
            assert result.dispatched == 1
            assert task_store.get_task(high["id"])["status"] == "running"
            assert task_store.get_task(low["id"])["status"] == "assigned"

    asyncio.run(run_flow())


def test_scheduler_records_skip_activity_once_for_agentless_due_routine() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            backend = ServerDaemonNodeBackend(registry)
            routine = task_store.create_task(
                {
                    "title": "Agentless routine",
                    "assigneeEmployeeId": "alice",
                    "isRoutine": True,
                    "routineCadence": "weekly",
                    "routineNextRunDate": "2026-06-25",
                    "routineEnabled": True,
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                today=lambda: date(2026, 6, 25),
            )

            first = await scheduler.tick()
            second = await scheduler.tick()

            assert first.promoted == 0
            assert first.skipped == 1
            assert second.skipped == 1
            skips = [
                activity
                for activity in task_store.get_task(routine["id"])["activity"]
                if activity["message"] == ROUTINE_SKIP_NO_AGENT_MESSAGE
            ]
            assert len(skips) == 1

    asyncio.run(run_flow())


def test_scheduler_backs_off_after_failed_dispatch() -> None:
    class FailingBackend:
        def __init__(self) -> None:
            self.calls = 0

        async def run(self, node_id: str, request: dict) -> dict:
            self.calls += 1
            raise ValueError("capacity_exhausted: node is full")

    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            routing_backend, agent = _logical_backend(root, registry, "sbx_alice")
            backend = FailingBackend()
            backend.agent_store = routing_backend.agent_store
            backend.agent_placement_store = routing_backend.agent_placement_store
            task = task_store.create_task(
                {
                    "title": "Keeps failing",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                jitter=lambda: 0.5,
            )

            first = await scheduler.tick()
            second = await scheduler.tick()

            assert first.dispatched == 0
            assert backend.calls == 1
            # The failed task is back in the queue with a persisted retry
            # deadline, so the immediate retick does not re-run it.
            failed = task_store.get_task(task["id"])
            assert failed["status"] == "assigned"
            assert failed["assignedAgentId"] == agent["id"]
            assert "dispatchClaim" not in failed
            assert failed["dispatchOutcome"]["code"] == "capacity_exhausted"
            retry = failed["dispatchRetry"]
            assert retry["failureCount"] == 1
            assert retry["code"] == "capacity_exhausted"
            assert "capacity_exhausted: node is full" in retry["message"]
            deadline = datetime.fromisoformat(retry["nextAttemptAt"])
            assert deadline > datetime.now(UTC)
            assert second.dispatched == 0
            # Queue storage filters deferred tasks before the scheduler loads
            # routing state, so an immediate retick has no candidate to skip.
            assert second.skipped == 0
            assert backend.calls == 1

    asyncio.run(run_flow())


def test_scheduler_keeps_the_claim_on_ambiguous_dispatch_failure() -> None:
    """An unclassified failure may have been accepted by the daemon, so the
    claim is retained and no retry budget is consumed: no retry event, no
    deadline, no failure count."""

    class FailingBackend:
        def __init__(self) -> None:
            self.calls = 0

        async def run(self, node_id: str, request: dict) -> dict:
            self.calls += 1
            raise ValueError("dispatch rejected")

    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            routing_backend, agent = _logical_backend(root, registry, "sbx_alice")
            backend = FailingBackend()
            backend.agent_store = routing_backend.agent_store
            backend.agent_placement_store = routing_backend.agent_placement_store
            task = task_store.create_task(
                {
                    "title": "Ambiguous failure",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            )

            first = await scheduler.tick()
            second = await scheduler.tick()

            assert first.dispatched == 0
            assert backend.calls == 1
            failed = task_store.get_task(task["id"])
            assert failed["status"] == "assigned"
            assert failed["dispatchClaim"]["id"]
            assert failed["dispatchOutcome"]["code"] == "dispatch_failed"
            assert "dispatchRetry" not in failed
            assert not [
                event
                for event in failed["events"]
                if event["type"] == "task.dispatch_retry"
            ]
            # The retained claim is still leased, so the retick refuses to
            # claim again rather than dispatching twice.
            assert second.dispatched == 0
            assert second.skipped == 1
            assert backend.calls == 1

    asyncio.run(run_flow())


def test_scheduler_retry_count_accumulates_across_restart() -> None:
    """A fresh scheduler against the same store must continue the persisted
    failure count instead of restarting it at one."""

    class FailingBackend:
        async def run(self, node_id: str, request: dict) -> dict:
            raise ValueError("capacity_exhausted: node is full")

    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            routing_backend, agent = _logical_backend(root, registry, "sbx_alice")
            backend = FailingBackend()
            backend.agent_store = routing_backend.agent_store
            backend.agent_placement_store = routing_backend.agent_placement_store
            task = task_store.create_task(
                {
                    "title": "Survives a restart",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )

            first_scheduler = TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                jitter=lambda: 0.5,
            )
            await first_scheduler.tick()
            assert (
                task_store.get_task(task["id"])["dispatchRetry"]["failureCount"] == 1
            )

            # The process restarts; the persisted deadline eventually elapses.
            task_store.record_dispatch_retry(
                task["id"],
                failure_count=1,
                next_attempt_at="2000-01-01T00:00:00Z",
                code="capacity_exhausted",
                message="node is full",
            )
            restarted_scheduler = TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                jitter=lambda: 0.5,
            )
            result = await restarted_scheduler.tick()

            assert result.dispatched == 0
            retry = task_store.get_task(task["id"])["dispatchRetry"]
            assert retry["failureCount"] == 2
            assert retry["code"] == "capacity_exhausted"

    asyncio.run(run_flow())


def test_scheduler_blocks_task_after_retry_budget_is_spent() -> None:
    class FailingBackend:
        async def run(self, node_id: str, request: dict) -> dict:
            raise ValueError("capacity_exhausted: node is full")

    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            routing_backend, agent = _logical_backend(root, registry, "sbx_alice")
            backend = FailingBackend()
            backend.agent_store = routing_backend.agent_store
            backend.agent_placement_store = routing_backend.agent_placement_store
            task = task_store.create_task(
                {
                    "title": "Runs out of retries",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                max_dispatch_failures=1,
                jitter=lambda: 0.5,
            )

            result = await scheduler.tick()

            assert result.dispatched == 0
            blocked = task_store.get_task(task["id"])
            assert blocked["status"] == "blocked"
            assert blocked["dispatchOutcome"]["state"] == "rejected"
            assert blocked["dispatchOutcome"]["code"] == "dispatch_retry_exhausted"
            assert blocked["dispatchRetry"]["failureCount"] == 1
            # A blocked task leaves the dispatch queue.
            assert await scheduler.tick() == SchedulerTickResult()

    asyncio.run(run_flow())


def test_dispatch_retry_delay_is_bounded_and_capped() -> None:
    base = dispatch_retry_delay(1, base_seconds=10.0, sample=lambda: 0.5)
    assert base == 20.0
    assert dispatch_retry_delay(1, base_seconds=10.0, sample=lambda: 0.0) == 16.0
    high = dispatch_retry_delay(1, base_seconds=10.0, sample=lambda: 0.999999)
    assert high < 24.0
    capped = dispatch_retry_delay(30, base_seconds=10.0, sample=lambda: 0.999999)
    assert capped <= MAX_DISPATCH_RETRY_DELAY_SECONDS * 1.2


def test_scheduler_uses_targeted_task_queue_queries() -> None:
    class QueryOnlyTaskStore:
        def __init__(self) -> None:
            self.due_queries = 0
            self.dispatch_queries = 0

        def list_due_routines(self, today: str) -> list[dict]:
            self.due_queries += 1
            return []

        def list_dispatchable_tasks(self) -> list[dict]:
            self.dispatch_queries += 1
            return []

        def list_tasks(self) -> list[dict]:
            raise AssertionError("scheduler should use targeted queue queries")

    async def run_flow() -> None:
        store = QueryOnlyTaskStore()
        scheduler = TaskScheduler(
            task_store=store,
            registry=object(),
            backend=object(),
            today=lambda: date(2026, 6, 25),
        )

        result = await scheduler.tick()

        assert result.promoted == 0
        assert result.dispatched == 0
        assert result.skipped == 0
        assert store.due_queries == 1
        assert store.dispatch_queries == 1

    asyncio.run(run_flow())


def test_scheduler_honors_a_persisted_retry_deadline_after_restart() -> None:
    class RetryOnlyTaskStore:
        def list_due_routines(self, today: str) -> list[dict]:
            return []

        def list_dispatchable_tasks(self) -> list[dict]:
            return [
                {
                    "id": "task_waiting",
                    "status": "assigned",
                    "assignedAgent": "codex",
                    "assignedAgentId": "agent_builder",
                    "dispatchRetry": {
                        "failureCount": 1,
                        "nextAttemptAt": "2099-01-01T00:00:00Z",
                    },
                }
            ]

    async def run_flow() -> None:
        scheduler = TaskScheduler(
            task_store=RetryOnlyTaskStore(),
            registry=object(),
            backend=SimpleNamespace(agent_store=object(), agent_placement_store=object()),
        )

        result = await scheduler.tick()

        assert result.dispatched == 0
        assert result.skipped == 1

    asyncio.run(run_flow())


def test_scheduler_materializes_and_dispatches_legacy_assignment() -> None:
    """A legacy `assignedAgent` runtime task resolves to an already-declared
    agent for that runtime/computer pair; agents are no longer auto-created."""

    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
            )
            node = registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            agent_store = LocalEmployeeAgentStore(root)
            placement_store = LocalAgentPlacementStore(root)
            declared = agent_store.create_agent(
                "alice",
                {
                    "displayName": "Codex",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                    "computerId": computer_id(node),
                },
            )
            backend = ServerDaemonNodeBackend(
                registry,
                employee_agent_store=agent_store,
                agent_placement_store=placement_store,
            )
            legacy = task_store.create_task(
                {
                    "title": "Legacy executor task",
                    "assignedAgent": "codex",
                    "ownerEmployeeId": "requester",
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )

            result = await TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            ).tick()

            assert result.dispatched == 1
            updated = task_store.get_task(legacy["id"])
            assert updated["assignedAgentId"] == declared["id"]
            commands = registry.take_commands("sbx_alice", "node_token")
            assert commands[0]["logicalAgentId"] == declared["id"]

    asyncio.run(run_flow())


def test_legacy_assignment_reuses_placement_after_runtime_replacement() -> None:
    """A placement is matched by the stable computerId, not the daemon node
    id, so a declared agent's placement survives a runtime re-registration
    under a new node id for the same computer — no duplicate is created."""
    with TemporaryDirectory() as root:
        agents = LocalEmployeeAgentStore(root)
        placements = LocalAgentPlacementStore(root)
        current = [
            {
                "id": "runtime_old",
                "employeeId": "alice",
                "workspaceId": "machine-1",
                "status": "ready",
                "agents": {"codex": "ready"},
            }
        ]
        registry = SimpleNamespace(
            daemon_store=SimpleNamespace(list_active_runs=list),
            list_ready=lambda: current,
            is_live=lambda _node_id: True,
        )
        task = {"assigneeEmployeeId": "alice"}
        declared = agents.create_agent(
            "alice",
            {
                "displayName": "Codex",
                "executorKind": "codex",
                "defaultRole": "implementer",
                "computerId": "device:alice:machine-1",
            },
        )

        first = materialize_legacy_agent_assignment(
            task,
            "codex",
            registry=registry,
            agent_store=agents,
            placement_store=placements,
        )
        assert first == {"agent": "codex", "agentId": declared["id"]}
        [original] = placements.list_placements(agent_id=first["agentId"])
        current[:] = [
            {
                **current[0],
                "id": "runtime_new",
            }
        ]

        second = materialize_legacy_agent_assignment(
            task,
            "codex",
            registry=registry,
            agent_store=agents,
            placement_store=placements,
        )

        assert second["agentId"] == first["agentId"]
        [preserved] = placements.list_placements(agent_id=first["agentId"])
        assert preserved["id"] == original["id"]
        assert preserved["daemonNodeId"] == "runtime_old"
        assert preserved["computerId"] == "device:alice:machine-1"


def test_scheduler_materializes_legacy_routine_before_promotion() -> None:
    """A declared agent for the routine's runtime/computer pair is required
    before the routine can be promoted; nothing is auto-created."""

    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
            )
            node = registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            agent_store = LocalEmployeeAgentStore(root)
            placement_store = LocalAgentPlacementStore(root)
            agent_store.create_agent(
                "alice",
                {
                    "displayName": "Codex",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                    "computerId": computer_id(node),
                },
            )
            backend = ServerDaemonNodeBackend(
                registry,
                employee_agent_store=agent_store,
                agent_placement_store=placement_store,
            )
            routine = task_store.create_task(
                {
                    "title": "Legacy executor routine",
                    "assignedAgent": "codex",
                    "assigneeEmployeeId": "alice",
                    "isRoutine": True,
                    "routineEnabled": True,
                    "routineCadence": "daily",
                    "routineNextRunDate": "2020-01-01",
                }
            )

            result = await TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            ).tick()

            assert result.promoted == 1
            updated = task_store.get_task(routine["id"])
            assert updated["assignedAgentId"]
            occurrence = task_store.get_task(updated["occurrenceIds"][0])
            assert occurrence["assignedAgentId"] == updated["assignedAgentId"]

    asyncio.run(run_flow())


def test_scheduler_routes_assignment_through_task_assignee() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            backend, agent = _logical_backend(root, registry, "sbx_alice")
            delegated = task_store.create_task(
                {
                    "title": "Delegated work",
                    "assignedAgent": "codex",
                    "assignedAgentId": agent["id"],
                    "ownerEmployeeId": "bob",
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )

            result = await TaskScheduler(
                task_store=task_store, registry=registry, backend=backend
            ).tick()

            assert result.dispatched == 1
            assert result.promoted == 0
            assert result.skipped == 0
            updated = task_store.get_task(delegated["id"])
            assert updated["status"] == "running"
            [command] = registry.take_commands("sbx_alice", "node_token")
            assert command["logicalAgentId"] == agent["id"]

    asyncio.run(run_flow())


def test_next_routine_date_skips_past_missed_windows_and_handles_custom() -> None:
    assert next_routine_date(date(2026, 6, 1), "daily", date(2026, 6, 25)) == date(
        2026, 6, 26
    )
    assert next_routine_date(date(2026, 1, 31), "monthly", date(2026, 2, 1)) == date(
        2026, 2, 28
    )
    assert next_routine_date(date(2026, 6, 25), "custom", date(2026, 6, 25)) is None


def test_scheduler_dispatches_all_team_members_lead_first() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex", "claude"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                    "maxConcurrentRuns": 2,
                },
                "ui_token",
            )
            agent_store = LocalEmployeeAgentStore(root)
            placements = LocalAgentPlacementStore(root)
            lead = agent_store.create_agent(
                "alice",
                {
                    "displayName": "Lead",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                },
            )
            support = agent_store.create_agent(
                "alice",
                {
                    "displayName": "Support",
                    "executorKind": "claude",
                    "defaultRole": "implementer",
                },
            )
            placements.create_placement(lead, "sbx_alice")
            placements.create_placement(support, "sbx_alice")
            backend = ServerDaemonNodeBackend(
                registry,
                employee_agent_store=agent_store,
                agent_placement_store=placements,
            )
            teams = LocalTeamStore(root)
            team = teams.create_team(
                "alice",
                {
                    "name": "Delivery",
                    "leadAgentId": lead["id"],
                    "memberAgentIds": [lead["id"], support["id"]],
                },
            )
            first = task_store.create_task(
                {
                    "title": "Lead work",
                    "assignedTeamId": team["id"],
                    "ownerEmployeeId": "requester",
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            scheduler = TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                team_store=teams,
            )

            result = await scheduler.tick()
            assert result.dispatched == 1
            [lead_command] = registry.take_commands("sbx_alice", "node_token")
            assert lead_command["logicalAgentId"] == lead["id"]
            assert lead_command["delivery"]["type"] == "assignment-attempt"
            assert task_store.get_task(first["id"])["status"] == "running"
            [session_id] = task_store.get_task(first["id"])["linkedSessionIds"]
            [manifest] = registry.store.get_session(session_id)["collaborationRounds"]
            assert manifest["teamSnapshot"]["teamId"] == team["id"]
            assert len(manifest["workGraph"]["items"]) == 2
            assert manifest["workGraph"]["items"][1]["dependsOnWorkItemIds"] == [
                manifest["workGraph"]["items"][0]["workItemId"]
            ]
            registry.handle_event(
                "sbx_alice",
                {
                    "type": "run.completed",
                    "commandId": lead_command["id"],
                    "sessionId": lead_command["sessionId"],
                    "runId": lead_command["runId"],
                    "agent": "codex",
                    "exitCode": 0,
                    "agentLog": "done",
                },
                "node_token",
            )
            [support_command] = registry.take_commands("sbx_alice", "node_token")
            assert support_command["logicalAgentId"] == support["id"]
            assert support_command["agent"] == "claude"
            registry.handle_event(
                "sbx_alice",
                {
                    "type": "run.completed",
                    "commandId": support_command["id"],
                    "sessionId": support_command["sessionId"],
                    "runId": support_command["runId"],
                    "agent": "claude",
                    "exitCode": 0,
                    "agentLog": "reviewed",
                },
                "node_token",
            )

            agent_store.update_agent(lead["id"], {"enabled": False})
            second = task_store.create_task(
                {
                    "title": "Blocked lead work",
                    "assignedTeamId": team["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )
            result = await scheduler.tick()
            assert result.dispatched == 0
            assert result.skipped == 1
            assert registry.take_commands("sbx_alice", "node_token") == []
            updated = task_store.get_task(second["id"])
            assert updated["status"] == "blocked"
            assert updated["dispatchOutcome"]["state"] == "rejected"
            assert updated["dispatchOutcome"]["code"] == "team_disabled"
            assert (
                updated["dispatchOutcome"]["message"]
                == "The assigned team cannot execute this task (team_disabled)."
            )

    asyncio.run(run_flow())


def test_scheduler_promotes_team_routine_into_team_owned_thread() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            session_store = LocalSessionStore(root)
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                session_store, LocalDaemonStore(root), task_store=task_store
            )
            registry.register(
                {
                    "sandboxId": "sbx_alice",
                    "employeeId": "alice",
                    "token": "node_token",
                    "workspacePath": "/workspace/alice",
                    "protocolVersion": 1,
                    "supportedAgents": ["codex", "claude"],
                    "capabilities": ["task-workspaces", "thread-workspaces"],
                    "status": "ready",
                },
                "ui_token",
            )
            agent_store = LocalEmployeeAgentStore(root)
            placements = LocalAgentPlacementStore(root)
            lead = agent_store.create_agent(
                "alice",
                {
                    "displayName": "Lead",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                },
            )
            support = agent_store.create_agent(
                "alice",
                {
                    "displayName": "Support",
                    "executorKind": "claude",
                    "defaultRole": "implementer",
                },
            )
            placements.create_placement(lead, "sbx_alice")
            placements.create_placement(support, "sbx_alice")
            backend = ServerDaemonNodeBackend(
                registry,
                employee_agent_store=agent_store,
                agent_placement_store=placements,
            )
            teams = LocalTeamStore(root)
            team = teams.create_team(
                "alice",
                {
                    "name": "Routine delivery",
                    "leadAgentId": lead["id"],
                    "memberAgentIds": [lead["id"], support["id"]],
                },
            )
            routine = task_store.create_task(
                {
                    "title": "Daily Team report",
                    "ownerEmployeeId": "requester",
                    "assigneeEmployeeId": "alice",
                    "assignedTeamId": team["id"],
                    "isRoutine": True,
                    "routineType": "task",
                    "routineCadence": "daily",
                    "routineNextRunDate": "2026-07-23",
                    "routineEnabled": True,
                }
            )

            result = await TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                team_store=teams,
                today=lambda: date(2026, 7, 23),
            ).tick()

            assert result.promoted == 1
            assert result.dispatched == 1
            [occurrence_id] = task_store.get_task(routine["id"])["occurrenceIds"]
            occurrence = task_store.get_task(occurrence_id)
            assert occurrence["assignedTeamId"] == team["id"]
            assert occurrence["sourceRoutineId"] == routine["id"]
            [session_id] = occurrence["linkedSessionIds"]
            session = session_store.get_session(session_id)
            assert session["teamId"] == team["id"]
            assert session["ownerEmployeeId"] == "alice"
            assert session["ownerAgentId"] == lead["id"]
            [lead_command] = registry.take_commands("sbx_alice", "node_token")
            assert lead_command["logicalAgentId"] == lead["id"]
            registry.handle_event(
                "sbx_alice",
                {
                    "type": "run.completed",
                    "commandId": lead_command["id"],
                    "sessionId": lead_command["sessionId"],
                    "runId": lead_command["runId"],
                    "agent": "codex",
                    "exitCode": 0,
                    "agentLog": "lead result",
                },
                "node_token",
            )
            [support_command] = registry.take_commands("sbx_alice", "node_token")
            assert support_command["logicalAgentId"] == support["id"]
            assert support_command["agent"] == "claude"

    asyncio.run(run_flow())


def test_scheduler_records_team_unavailable_without_claiming() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
            )
            agent_store = LocalEmployeeAgentStore(root)
            placements = LocalAgentPlacementStore(root)
            member = agent_store.create_agent(
                "alice",
                {
                    "displayName": "Unavailable",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                    "enabled": False,
                },
            )
            backend = ServerDaemonNodeBackend(
                registry,
                employee_agent_store=agent_store,
                agent_placement_store=placements,
            )
            teams = LocalTeamStore(root)
            team = teams.create_team(
                "alice",
                {
                    "name": "Delivery",
                    "leadAgentId": member["id"],
                    "memberAgentIds": [member["id"]],
                },
            )
            task = task_store.create_task(
                {
                    "title": "Wait for the team",
                    "assignedTeamId": team["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )

            result = await TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                team_store=teams,
            ).tick()

            updated = task_store.get_task(task["id"])
            assert result.dispatched == 0
            assert updated["status"] == "blocked"
            assert updated["dispatchOutcome"]["state"] == "rejected"
            assert updated["dispatchOutcome"]["code"] == "team_disabled"
            assert "dispatchClaim" not in updated

    asyncio.run(run_flow())


def test_scheduler_requests_managed_capacity_for_unroutable_team_lead() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store = LocalTaskStore(root)
            registry = DaemonNodeRegistry(
                LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
            )
            managed_nodes = LocalManagedNodeStore(root)
            agent_store = LocalEmployeeAgentStore(root)
            placements = LocalAgentPlacementStore(root)
            lead = agent_store.create_agent(
                "alice",
                {
                    "displayName": "Lead",
                    "executorKind": "codex",
                    "defaultRole": "implementer",
                },
            )
            backend = ServerDaemonNodeBackend(
                registry,
                employee_agent_store=agent_store,
                agent_placement_store=placements,
            )
            teams = LocalTeamStore(root)
            team = teams.create_team(
                "alice",
                {
                    "name": "Delivery",
                    "leadAgentId": lead["id"],
                    "memberAgentIds": [lead["id"]],
                },
            )
            task_store.create_task(
                {
                    "title": "Provision for the Team lead",
                    "assignedTeamId": team["id"],
                    "assigneeEmployeeId": "alice",
                    "status": "assigned",
                }
            )

            result = await TaskScheduler(
                task_store=task_store,
                registry=registry,
                backend=backend,
                team_store=teams,
                managed_node_store=managed_nodes,
            ).tick()

            assert result.dispatched == 0
            assert result.skipped == 1
            [managed] = managed_nodes.list_nodes()
            assert managed["employeeId"] == "alice"
            assert managed["desiredState"] == "running"

    asyncio.run(run_flow())


class _FixedOrgSettings:
    def __init__(self, max_task_rounds: int) -> None:
        self._settings = {"maxTaskRounds": max_task_rounds}

    def get_settings(self) -> dict:
        return dict(self._settings)


def _round_scheduler_fixture(root: str, *, max_task_rounds: int):
    task_store = LocalTaskStore(root)
    registry = DaemonNodeRegistry(
        LocalSessionStore(root), LocalDaemonStore(root), task_store=task_store
    )
    registry.register(
        {
            "sandboxId": "sbx_alice",
            "employeeId": "alice",
            "token": "node_token",
            "workspacePath": "/workspace/alice",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["task-workspaces", "thread-workspaces", "round-result"],
            "status": "ready",
        },
        "ui_token",
    )
    agent_store = LocalEmployeeAgentStore(root)
    placements = LocalAgentPlacementStore(root)
    agent = agent_store.create_agent(
        "alice",
        {"displayName": "Solo", "executorKind": "codex", "defaultRole": "implementer"},
    )
    placements.create_placement(agent, "sbx_alice")
    backend = ServerDaemonNodeBackend(
        registry, employee_agent_store=agent_store, agent_placement_store=placements
    )
    scheduler = TaskScheduler(
        task_store=task_store,
        registry=registry,
        backend=backend,
        org_settings_store=_FixedOrgSettings(max_task_rounds),
    )
    task = task_store.create_task(
        {
            "title": "Migrate the billing tables",
            "assignedAgent": "codex",
            "assignedAgentId": agent["id"],
            "assigneeEmployeeId": "alice",
            "status": "assigned",
        }
    )
    return task_store, registry, scheduler, task


def _report_round(registry, command, status: str) -> None:
    registry.handle_event(
        "sbx_alice",
        {
            "type": "run.completed",
            "commandId": command["id"],
            "sessionId": command["sessionId"],
            "runId": command["runId"],
            "agent": "codex",
            "exitCode": 0,
            "agentLog": "worked",
            "roundResult": {"status": status, "note": "more to do"},
        },
        "node_token",
    )


def test_scheduler_runs_a_second_round_in_the_same_thread() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store, registry, scheduler, task = _round_scheduler_fixture(
                root, max_task_rounds=3
            )

            assert (await scheduler.tick()).dispatched == 1
            [first] = registry.take_commands("sbx_alice", "node_token")
            _report_round(registry, first, "continue")

            assert (await scheduler.tick()).dispatched == 1
            [second] = registry.take_commands("sbx_alice", "node_token")

            # Same thread, so the second round opens the workspace the first
            # round left behind instead of an empty one.
            assert second["sessionId"] == first["sessionId"]
            assert second["runId"] != first["runId"]
            _report_round(registry, second, "done")

            finished = task_store.get_task(task["id"])
            assert finished["status"] == "done"
            assert finished["roundCount"] == 1

    asyncio.run(run_flow())


def test_scheduler_stops_a_task_that_never_reports_itself_finished() -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            task_store, registry, scheduler, task = _round_scheduler_fixture(
                root, max_task_rounds=2
            )

            for _ in range(2):
                assert (await scheduler.tick()).dispatched == 1
                [command] = registry.take_commands("sbx_alice", "node_token")
                _report_round(registry, command, "continue")

            # Budget spent: the next tick refuses instead of looping forever.
            assert (await scheduler.tick()).dispatched == 0
            assert registry.take_commands("sbx_alice", "node_token") == []
            stopped = task_store.get_task(task["id"])
            assert stopped["status"] == "waiting_for_human"
            assert stopped["dispatchOutcome"]["code"] == "round_budget_exhausted"
            assert "2-round budget" in stopped["activity"][-1]["message"]

    asyncio.run(run_flow())


def _legacy_fixture(root: str):
    """A registered claude computer plus empty agent/placement stores."""
    session_store = LocalSessionStore(root)
    task_store = LocalTaskStore(root)
    registry = DaemonNodeRegistry(
        session_store, LocalDaemonStore(root), task_store=task_store
    )
    registry.register(
        {
            "sandboxId": "sbx_alice",
            "employeeId": "alice",
            "token": "node_token",
            "workspacePath": "/workspace/alice",
            "workspaceId": "machine-a",
            "protocolVersion": 1,
            "supportedAgents": ["claude"],
            "capabilities": ["task-workspaces", "thread-workspaces"],
            "status": "ready",
        }
    )
    return (
        registry,
        LocalEmployeeAgentStore(root),
        LocalAgentPlacementStore(root),
        {"id": "task-1", "ownerEmployeeId": "alice", "assignments": [{"agent": "claude"}]},
    )


def _declare(agents, display_name: str):
    return agents.create_agent(
        "alice",
        {
            "displayName": display_name,
            "executorKind": "claude",
            "defaultRole": "implementer",
            "computerId": "device:alice:machine-a",
        },
    )


def test_legacy_assignment_resolves_to_a_declared_agent() -> None:
    with TemporaryDirectory() as root:
        registry, agents, placements, task = _legacy_fixture(root)
        agent = _declare(agents, "Ada")
        resolved = materialize_legacy_agent_assignment(
            task,
            "claude",
            registry=registry,
            agent_store=agents,
            placement_store=placements,
        )
        assert resolved == {"agent": "claude", "agentId": agent["id"]}


def test_legacy_assignment_without_a_declared_agent_creates_nothing() -> None:
    with TemporaryDirectory() as root:
        registry, agents, placements, task = _legacy_fixture(root)
        resolved = materialize_legacy_agent_assignment(
            task,
            "claude",
            registry=registry,
            agent_store=agents,
            placement_store=placements,
        )
        assert resolved is None
        assert agents.list_agents(supervisor_employee_id="alice") == []


def test_legacy_assignment_picks_deterministically_among_candidates() -> None:
    with TemporaryDirectory() as root:
        registry, agents, placements, task = _legacy_fixture(root)
        first = _declare(agents, "Ada")
        second = _declare(agents, "Grace")
        expected = min(
            (first, second), key=lambda agent: (agent["createdAt"], agent["id"])
        )["id"]
        for _ in range(3):
            resolved = materialize_legacy_agent_assignment(
                task,
                "claude",
                registry=registry,
                agent_store=agents,
                placement_store=placements,
            )
            assert resolved["agentId"] == expected
