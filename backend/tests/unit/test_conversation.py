from __future__ import annotations

from typing import Any

from relay.sessions import compute_conversation_history


class _FakeStore:
    def __init__(self, bodies: dict[str, str]) -> None:
        self._bodies = bodies

    def read_artifact(self, session_id: str, artifact_id: str) -> str:
        return self._bodies[artifact_id]


def test_handoff_constraints_survive_a_followup_with_target_scope() -> None:
    session = _session(events=[
        {"type": "human.decision", "timestamp": "2026-06-20T00:01:00.000Z",
         "decision": {"kind": "handoff", "targetAgent": "codex",
                      "targetAgentId": "reviewer", "note": "Preserve the public API."}},
        {"type": "user.message", "timestamp": "2026-06-20T00:02:00.000Z", "text": "Continue"},
    ])
    history = compute_conversation_history(session, _FakeStore({}))
    assert "Preserve the public API." in history
    assert "codex" in history and "reviewer" in history


def _session(
    *,
    task_goal: str = "first question",
    events: list[dict[str, Any]] | None = None,
    runs: list[dict[str, Any]] | None = None,
    artifacts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "id": "ses_1",
        "createdAt": "2026-06-20T00:00:00.000Z",
        "taskGoal": task_goal,
        "events": events or [],
        "agentRuns": runs or [],
        "artifacts": artifacts or [],
    }


def test_compute_conversation_history_returns_none_for_first_turn() -> None:
    assert compute_conversation_history(_session(), _FakeStore({})) is None


def test_compute_conversation_history_includes_turns_before_latest_user_message() -> None:
    session = _session(
        events=[
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:02:00.000Z",
                "text": "follow up",
            }
        ],
        runs=[
            {
                "id": "run_1",
                "agent": "claude",
                "status": "completed",
                "startedAt": "2026-06-20T00:00:10.000Z",
                "completedAt": "2026-06-20T00:01:00.000Z",
                "artifactIds": [],
                "agentLog": "● first answer\nwith detail",
            }
        ],
        artifacts=[],
    )

    out = compute_conversation_history(session, _FakeStore({}))

    assert out == (
        "[Conversation so far]\n\n"
        "[User]\nfirst question\n\n"
        "[Assistant @claude]\nfirst answer\nwith detail"
    )


def test_compute_conversation_history_excludes_agent_runs_after_latest_user_message() -> None:
    session = _session(
        events=[
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:02:00.000Z",
                "text": "follow up",
            }
        ],
        runs=[
            {
                "id": "run_old",
                "agent": "claude",
                "status": "completed",
                "startedAt": "2026-06-20T00:00:10.000Z",
                "completedAt": "2026-06-20T00:01:00.000Z",
                "artifactIds": ["old"],
            },
            {
                "id": "run_current",
                "agent": "pi",
                "status": "completed",
                "startedAt": "2026-06-20T00:02:10.000Z",
                "completedAt": "2026-06-20T00:03:00.000Z",
                "artifactIds": ["current"],
            },
        ],
        artifacts=[
            {"id": "old", "kind": "command_log"},
            {"id": "current", "kind": "command_log"},
        ],
    )

    out = compute_conversation_history(
        session,
        _FakeStore({"old": "● older answer", "current": "● current-turn answer"}),
    )

    assert out is not None
    assert "older answer" in out
    assert "follow up" not in out
    assert "current-turn answer" not in out


def test_compute_conversation_history_includes_failed_runs_before_latest_user_message() -> None:
    session = _session(
        events=[
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:02:00.000Z",
                "text": "follow up",
            }
        ],
        runs=[
            {
                "id": "run_1",
                "agent": "claude",
                "status": "failed",
                "exitCode": 1,
                "startedAt": "2026-06-20T00:00:10.000Z",
                "completedAt": "2026-06-20T00:01:00.000Z",
                "artifactIds": [],
                "agentLog": "fatal setup error",
            }
        ],
    )

    out = compute_conversation_history(session, _FakeStore({}))

    assert out == (
        "[Conversation so far]\n\n"
        "[User]\nfirst question\n\n"
        "[Assistant @claude - failed, exit 1]\nfatal setup error"
    )


def test_compute_conversation_history_caps_oldest_blocks() -> None:
    session = _session(
        events=[
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:01:00.000Z",
                "text": "old follow up",
            },
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:02:00.000Z",
                "text": "near current follow up",
            },
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:03:00.000Z",
                "text": "current turn",
            },
        ]
    )

    out = compute_conversation_history(session, _FakeStore({}), max_blocks=1, max_chars=1000)

    assert out == (
        "[Conversation so far]\n\n"
        "[Earlier conversation omitted]\n\n"
        "[User]\nnear current follow up"
    )


def test_elided_history_names_the_progress_log_when_the_run_keeps_one() -> None:
    session = _session(
        events=[
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:01:00.000Z",
                "text": "old follow up",
            },
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:02:00.000Z",
                "text": "near current follow up",
            },
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:03:00.000Z",
                "text": "current turn",
            },
        ]
    )

    out = compute_conversation_history(
        session,
        _FakeStore({}),
        max_blocks=1,
        max_chars=1000,
        progress_file="PROGRESS.md",
    )

    assert out == (
        "[Conversation so far]\n\n"
        "[Earlier conversation omitted — consult `PROGRESS.md` in the workspace "
        "if present for earlier decisions and state; verify it against the current workspace]\n\n"
        "[User]\nnear current follow up"
    )
