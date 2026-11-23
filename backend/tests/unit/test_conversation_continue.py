"""An agent's next turn in a thread continues its own runtime conversation.

A follow-up message, a task's next round, and an automation's next round all
deliver a run into a thread the agent already worked in. On a daemon that can
continue, that run resumes the agent's runtime conversation and reads only
what happened since its last turn; everywhere else it replays the transcript.
"""
from __future__ import annotations

import asyncio
from tempfile import TemporaryDirectory
from typing import Any

import pytest
from relay.daemon_registry.node_backend import ServerDaemonNodeBackend
from relay.daemon_registry.records import continuable_run, resumable_runtime_session
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.sessions.conversation import compute_conversation_since
from store_fixtures import make_daemon_store, make_session_store

SESSION_ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"
CONTINUE = ["agent-resume", "agent-continue"]


def _registry(root: str, capabilities: list[str]) -> tuple[Any, Any]:
    sessions = make_session_store(root)
    registry = DaemonNodeRegistry(sessions, make_daemon_store(root))
    registry.register({
        "sandboxId": "sbx_alice", "userId": "alice", "token": "node_token",
        "workspacePath": "/workspace/alice", "protocolVersion": 2,
        "supportedAgents": ["claude"],
        "capabilities": ["workspace-scope", "thread-workspaces", *capabilities],
        "status": "ready",
    })
    return sessions, registry


def _complete(registry: Any, command: dict[str, Any], **fields: Any) -> None:
    registry.handle_event("sbx_alice", {
        "type": "run.completed", "commandId": command["id"], "runId": command["runId"],
        "sessionId": command["sessionId"], "agent": "claude", "exitCode": 0,
        "agentLog": "● first answer", "leaseId": command["leaseId"], **fields,
    }, "node_token")


def _second_turn_state(capabilities: list[str], **first_fields: Any) -> dict[str, Any]:
    async def flow() -> dict[str, Any]:
        with TemporaryDirectory() as root:
            _sessions, registry = _registry(root, capabilities)
            backend = ServerDaemonNodeBackend(registry)
            await backend.run("sbx_alice", {"taskGoal": "first", "assignments": [{"agent": "claude"}]})
            [first] = registry.take_commands("sbx_alice", "node_token")
            _complete(registry, first, **first_fields)
            await backend.run("sbx_alice", {"sessionId": first["sessionId"], "taskGoal": "second",
                                            "assignments": [{"agent": "claude"}]})
            [second] = registry.take_commands("sbx_alice", "node_token")
            return second["state"]
    return asyncio.run(flow())


def test_a_follow_up_turn_continues_the_agents_conversation():
    state = _second_turn_state(CONTINUE, runtimeSessionId=SESSION_ID)

    assert state["resume_session_id"] == SESSION_ID
    assert state["resume_mode"] == "continue"
    # The full transcript still travels: a conversation the runtime cannot
    # find makes the daemon start fresh, and that run needs it.
    assert "first answer" in state["prior_conversation"]


@pytest.mark.parametrize("capabilities", [[], ["agent-resume"]])
def test_a_daemon_that_cannot_continue_replays_the_transcript(capabilities):
    state = _second_turn_state(capabilities, runtimeSessionId=SESSION_ID)

    assert "resume_session_id" not in state
    assert "resume_mode" not in state
    assert "first answer" in state["prior_conversation"]


def test_a_run_that_reported_no_conversation_is_not_continued():
    state = _second_turn_state(CONTINUE)

    assert "resume_session_id" not in state


def _run(**fields: Any) -> dict[str, Any]:
    return {"id": "run_1", "agent": "claude", "logicalAgentId": "agent_a", "status": "completed",
            "runtimeSessionId": SESSION_ID, "placementId": "pl_1", **fields}


ASSIGNMENT = {"agentId": "agent_a", "executorKind": "claude", "placementId": "pl_1"}


def test_continuable_run_is_the_agents_newest_settled_run():
    older = _run(id="run_0", runtimeSessionId="aaaaaaaa-old")
    session = {"agentRuns": [older, _run(), _run(id="run_x", logicalAgentId="agent_b")]}

    run = continuable_run(session, ASSIGNMENT)

    assert run is not None and run["id"] == "run_1"


@pytest.mark.parametrize("change", [
    {"status": "running"},
    {"runtimeSessionId": None},
    {"placementId": "pl_elsewhere"},
    # An agent switched to another runtime cannot pick its old one back up.
    {"agent": "codex"},
])
def test_continuable_run_refuses_a_conversation_it_cannot_safely_resume(change):
    assert continuable_run({"agentRuns": [_run(**change)]}, ASSIGNMENT) is None


def test_a_rerun_never_resumes_another_runtimes_conversation():
    assert resumable_runtime_session({"agentRuns": [_run(agent="codex")]}, ASSIGNMENT) is None


class _NoArtifacts:
    def read_artifact(self, session_id: str, artifact_id: str) -> str:
        raise KeyError(artifact_id)


def _event(kind: str, timestamp: str, **fields: Any) -> dict[str, Any]:
    return {"type": kind, "timestamp": timestamp, **fields}


def test_conversation_since_holds_only_what_the_agent_did_not_see():
    session = {
        "createdAt": "2026-11-23T10:00:00Z",
        "taskGoal": "first request",
        "events": [
            _event("session.created", "2026-11-23T10:00:00Z"),
            _event("agent.completed", "2026-11-23T10:01:00Z", runId="run_a"),
            _event("user.message", "2026-11-23T10:02:00Z", text="a note in between"),
            _event("agent.completed", "2026-11-23T10:03:00Z", runId="run_b"),
            _event("user.message", "2026-11-23T10:04:00Z", text="the current turn"),
        ],
        "agentRuns": [
            {"id": "run_a", "agent": "claude", "status": "completed"},
            {"id": "run_b", "agent": "codex", "status": "completed"},
        ],
    }

    since = compute_conversation_since(session, _NoArtifacts(), ("2026-11-23T10:01:00Z", 1))

    assert since is not None
    assert since.startswith("[Since your last turn in this thread]")
    assert "a note in between" in since
    assert "@codex" in since
    assert "first request" not in since  # already in the agent's own conversation
    assert "@claude" not in since
    assert "the current turn" not in since  # the prompt appends it last


def test_conversation_since_is_empty_when_nothing_happened():
    session = {
        "createdAt": "2026-11-23T10:00:00Z",
        "taskGoal": "first request",
        "events": [
            _event("session.created", "2026-11-23T10:00:00Z"),
            _event("agent.completed", "2026-11-23T10:01:00Z", runId="run_a"),
            _event("user.message", "2026-11-23T10:02:00Z", text="the current turn"),
        ],
        "agentRuns": [{"id": "run_a", "agent": "claude", "status": "completed"}],
    }

    assert compute_conversation_since(session, _NoArtifacts(), ("2026-11-23T10:01:00Z", 1)) is None
