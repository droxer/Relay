"""A task's next round runs in the thread, and the conversation, it left off in."""
from __future__ import annotations

import asyncio
from tempfile import TemporaryDirectory
from typing import Any

from fastapi.testclient import TestClient
from relay.app import create_app
from relay.tasks.scheduler import TaskScheduler

from test_task_dispatch import ALICE, ROUTINE_RUN, _agent, _bootstrap_admin, _register_node

RUNTIME_SESSION = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
CAPABILITIES = [
    "workspace-scope", "thread-workspaces", "task-workspaces", "round-result",
    "agent-resume", "agent-continue",
]


def _world(monkeypatch, root: str) -> tuple[Any, Any, dict[str, Any], dict[str, Any], TaskScheduler]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(root)
    client = TestClient(app)
    _bootstrap_admin(client)
    node = _register_node(app, "sbx_alice", capabilities=CAPABILITIES)
    agent = _agent(app, node)
    # An Automation occurrence: projectless work the scheduler picks up as is.
    task = app.state.task_store.create_task({
        **ROUTINE_RUN, "title": "Migrate billing", "assignedAgent": "codex",
        "assignedAgentId": agent["id"], "ownerUserId": ALICE, "assigneeUserId": ALICE,
        "status": "assigned",
    })
    scheduler = TaskScheduler(task_store=app.state.task_store, registry=app.state.registry,
                              backend=app.state.backend)
    return app, client, node, task, scheduler


def _round(app, scheduler: TaskScheduler, node: dict[str, Any]) -> dict[str, Any]:
    outcome = asyncio.run(scheduler.tick())
    commands = [c for c in app.state.registry.take_commands(node["id"], "token_sbx_alice")
                if c["type"] == "run.start"]
    assert len(commands) == 1, (outcome, [
        (t.get("status"), t.get("dispatchOutcome")) for t in app.state.task_store.list_tasks()
    ])
    command = commands[0]
    app.state.registry.handle_event(node["id"], {
        "type": "run.executing", "commandId": command["id"], "leaseId": command.get("leaseId"),
        **{key: command[key] for key in ("sessionId", "runId", "agent")},
    }, "token_sbx_alice")
    return command


def _continue(app, node: dict[str, Any], command: dict[str, Any]) -> None:
    app.state.registry.handle_event(node["id"], {
        "type": "run.completed", "commandId": command["id"], "sessionId": command["sessionId"],
        "runId": command["runId"], "agent": "codex", "exitCode": 0, "agentLog": "● half done",
        "leaseId": command.get("leaseId"), "runtimeSessionId": RUNTIME_SESSION,
        "roundResult": {"status": "continue", "note": "schema left"},
    }, "token_sbx_alice")


def test_a_continued_round_runs_in_the_same_thread_and_conversation(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, _client, node, task, scheduler = _world(monkeypatch, root)
        first = _round(app, scheduler, node)
        _continue(app, node, first)

        second = _round(app, scheduler, node)

        assert second["sessionId"] == first["sessionId"]
        assert second["state"]["resume_session_id"] == RUNTIME_SESSION
        assert second["state"]["resume_mode"] == "continue"
        assert app.state.task_store.get_task(task["id"])["linkedSessionIds"] == [first["sessionId"]]


def test_a_continuation_whose_thread_was_deleted_stops_for_a_person(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        app, _client, node, task, scheduler = _world(monkeypatch, root)
        first = _round(app, scheduler, node)
        _continue(app, node, first)
        # The thread-deletion path: the thread goes, and its Tasks drop the link.
        assert app.state.session_store.delete_session_with_task_unlinks(
            first["sessionId"], app.state.task_store, deleted_by=ALICE)

        asyncio.run(scheduler.tick())

        # No run is sent into a thread that no longer exists, and none is
        # started in a fresh one that would silently lack the work done so far.
        commands = app.state.registry.take_commands(node["id"], "token_sbx_alice")
        assert [c for c in commands if c["type"] == "run.start"] == []
        waiting = app.state.task_store.get_task(task["id"])
        assert waiting["status"] == "waiting_for_human"
        assert waiting["dispatchOutcome"]["code"] == "round_continuation_unavailable"
        assert "continuationSessionId" not in waiting

        # The person unblocking it is the way out: the work restarts in a
        # fresh thread rather than failing on the missing one again.
        app.state.task_store.update_task(task["id"], {"status": "assigned"})
        restarted = _round(app, scheduler, node)
        assert restarted["sessionId"] != first["sessionId"]
        assert app.state.task_store.get_task(task["id"])["status"] != "blocked"
