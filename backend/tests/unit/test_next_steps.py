"""Suggested next steps: from a run's control file to the thread's completion."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from relay.core.next_steps import (
    NEXT_STEP_MAX_CHARS,
    NEXT_STEPS_MAX,
    NEXT_STEPS_RELATIVE_PATH,
    sanitize_next_steps,
)
from relay.daemon_registry.node_backend import ServerDaemonNodeBackend
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.persistence.session.reducer import apply_session_event
from store_fixtures import make_daemon_store, make_session_store, make_task_store

REPO = Path(__file__).parents[3]
CORE = (REPO / "packages/relay-core/src/next-steps.ts").read_text()
WEB = (REPO / "web/src/lib/nextSteps.ts").read_text()


def _registry(root: str) -> tuple[Any, Any, Any]:
    sessions = make_session_store(root)
    tasks = make_task_store(root)
    registry = DaemonNodeRegistry(sessions, make_daemon_store(root), task_store=tasks)
    registry.register(
        {
            "sandboxId": "sbx_alice", "userId": "alice", "token": "node_token",
            "workspacePath": "/workspace/alice", "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["task-workspaces", "thread-workspaces", "round-result"],
            "status": "ready",
        },
        "ui_token",
    )
    return sessions, tasks, registry


def _complete(registry: Any, command: dict[str, Any], **fields: Any) -> None:
    registry.handle_event(
        "sbx_alice",
        {
            "type": "run.completed", "commandId": command["id"],
            **({"leaseId": command["leaseId"]} if command.get("leaseId") else {}),
            "sessionId": command["sessionId"], "runId": command["runId"],
            "agent": "codex", "exitCode": 0, "agentLog": "done", **fields,
        },
        "node_token",
    )


async def _thread_run(registry: Any, **request: Any) -> dict[str, Any]:
    await ServerDaemonNodeBackend(registry).run(
        "sbx_alice", {"taskGoal": "tidy the parser", "assignments": [{"agent": "codex"}], **request}
    )
    [command] = registry.take_commands("sbx_alice", "node_token")
    return command


def test_bounds_match_relay_core_and_the_web() -> None:
    for source in (CORE, WEB):
        assert re.search(rf"NEXT_STEPS_MAX = {NEXT_STEPS_MAX};", source)
        assert re.search(rf"NEXT_STEP_MAX_CHARS = {NEXT_STEP_MAX_CHARS};", source)
    assert f'NEXT_STEPS_RELATIVE_PATH = "{NEXT_STEPS_RELATIVE_PATH}";' in CORE


def test_sanitize_trims_dedupes_and_bounds() -> None:
    raw = ["  Add  tests ", "Add tests", 7, "", "x" * 500, "Ship it", "Too many"]
    assert sanitize_next_steps(raw) == ["Add tests", "x" * NEXT_STEP_MAX_CHARS, "Ship it"]
    assert sanitize_next_steps("Add tests") == []


def test_a_thread_run_is_asked_for_next_steps_and_its_completion_offers_them() -> None:
    async def flow() -> None:
        with TemporaryDirectory() as root:
            sessions, _tasks, registry = _registry(root)
            command = await _thread_run(registry)
            assert command["state"]["next_steps_file"] == NEXT_STEPS_RELATIVE_PATH

            _complete(registry, command, nextSteps=["Add tests for the parser", 3, "Add tests for the parser"])

            session = sessions.get_session(command["sessionId"])
            assert session["status"] == "completed"
            assert session["nextSteps"] == ["Add tests for the parser"]
            [completed] = [e for e in session["events"] if e["type"] == "session.completed"]
            assert completed["nextSteps"] == ["Add tests for the parser"]
    asyncio.run(flow())


def test_a_failed_run_offers_no_next_steps() -> None:
    async def flow() -> None:
        with TemporaryDirectory() as root:
            sessions, _tasks, registry = _registry(root)
            command = await _thread_run(registry)
            _complete(registry, command, exitCode=1, nextSteps=["Try again"])
            assert "nextSteps" not in sessions.get_session(command["sessionId"])
    asyncio.run(flow())


def test_a_round_that_asks_its_person_offers_its_answers_not_next_steps() -> None:
    async def flow() -> None:
        with TemporaryDirectory() as root:
            sessions, tasks, registry = _registry(root)
            task = tasks.create_task({"title": "Deploy"})
            command = await _thread_run(registry, taskId=task["id"])
            _complete(
                registry, command,
                roundResult={"status": "blocked", "note": "Which region?", "options": ["eu", "us"]},
                nextSteps=["Deploy to eu"],
            )
            session = sessions.get_session(command["sessionId"])
            assert session["inputOptions"] == ["eu", "us"]
            assert "nextSteps" not in session
    asyncio.run(flow())


def test_new_activity_retires_the_suggestions() -> None:
    session: dict[str, Any] = {"agentRuns": [], "events": []}
    apply_session_event(session, {
        "type": "session.completed", "timestamp": "t1", "outcome": "ok",
        "nextSteps": ["Add tests"],
    })
    assert session["nextSteps"] == ["Add tests"]
    apply_session_event(session, {
        "type": "agent.started", "timestamp": "t2", "runId": "r2", "agent": "codex",
    })
    assert "nextSteps" not in session
