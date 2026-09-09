from __future__ import annotations

from typing import Any

from relay.sessions import compute_prior_agent_bridge, extract_last_assistant_text


def test_bridge_bounds_long_current_turn_and_preserves_latest_result() -> None:
    session = {"id": "s", "events": [], "agentRuns": [
        {"agent": "codex", "agentLog": "● " + str(i) + "x" * 10000}
        for i in range(30)
    ]}
    session["agentRuns"][-1]["agentLog"] += "NEXT: verify migration"
    bridge = compute_prior_agent_bridge(session, "claude", _FakeStore({}))
    assert len(bridge) <= 16000
    assert "omitted" in bridge
    assert "NEXT: verify migration" in bridge


def test_bridge_bounds_one_oversized_result_without_losing_attribution() -> None:
    session = {"id": "s", "events": [], "agentRuns": [
        {"agent": "codex", "status": "cancelled", "agentLog": "● " + "x" * 50000 + "NEXT STEP"},
    ]}
    bridge = compute_prior_agent_bridge(session, "claude", _FakeStore({}))
    assert len(bridge) <= 16000
    assert "@codex - cancelled" in bridge
    assert bridge.endswith("NEXT STEP")


def test_bridge_bounds_many_small_results() -> None:
    session = {"id": "s", "events": [], "agentRuns": [
        {"agent": "codex", "agentLog": f"● result-{i}"} for i in range(40)
    ]}
    bridge = compute_prior_agent_bridge(session, "claude", _FakeStore({}))
    assert bridge.count("[Previous from") == 24
    assert bridge.endswith("result-39")


def test_extract_last_assistant_text_empty_returns_none() -> None:
    assert extract_last_assistant_text("") is None
    assert extract_last_assistant_text("   \n\n") is None


def test_extract_last_assistant_text_no_marker_returns_none() -> None:
    assert extract_last_assistant_text("no marker here\njust text") is None


def test_extract_last_assistant_text_returns_last_segment() -> None:
    transcript = "● first turn\nsome body\n● second turn\nthe answer\n⏺ tool noise"
    assert extract_last_assistant_text(transcript) == "second turn\nthe answer"


def test_extract_last_assistant_text_strips_thinking_and_tool_lines() -> None:
    transcript = "○ thinking line\n● real text\nbody\n⏺ tool"
    assert extract_last_assistant_text(transcript) == "real text\nbody"


def test_extract_last_assistant_text_falls_back_when_segments_are_empty() -> None:
    assert extract_last_assistant_text("●   \n   \n") is None


def test_extract_last_assistant_text_reads_claude_stream_json_result() -> None:
    transcript = (
        "[Claude Code Exit 0]\n"
        "stdout:\n"
        '{"type":"stream_event","event":{"type":"message_start"}}\n'
        '{"type":"assistant","message":{"content":[{"type":"text","text":"draft"}]}}\n'
        '{"type":"result","subtype":"success","result":"final team handoff"}'
    )

    assert extract_last_assistant_text(transcript) == "final team handoff"


class _FakeStore:
    def __init__(self, bodies: dict[str, str]) -> None:
        self._bodies = bodies

    def read_artifact(self, session_id: str, artifact_id: str) -> str:
        return self._bodies[artifact_id]


def _session(
    runs: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    return {"id": "sess_1", "agentRuns": runs, "artifacts": artifacts}


def test_compute_prior_agent_bridge_returns_none_when_no_intervening_runs() -> None:
    session = _session([], [])
    store = _FakeStore({"a1": "● anything\nbody"})
    assert compute_prior_agent_bridge(session, "claude", store) is None


def test_compute_prior_agent_bridge_shares_all_current_turn_blocks() -> None:
    session = _session(
        [
            {"agent": "claude", "artifactIds": [], "agentLog": "● claude work"},
            {"agent": "codex", "artifactIds": [], "agentLog": "● review note\ndetail"},
        ],
        [],
    )
    store = _FakeStore({})
    out = compute_prior_agent_bridge(session, "claude", store)
    assert out == "[Previous from @claude]\nclaude work\n\n[Previous from @codex]\nreview note\ndetail"


def test_compute_prior_agent_bridge_uses_no_output_when_artifact_missing() -> None:
    session = _session(
        [
            {"agent": "claude", "artifactIds": ["a1"]},
            {"agent": "codex", "artifactIds": ["missing"]},
        ],
        [{"id": "a1", "kind": "command_log"}],
    )
    store = _FakeStore({"a1": "● claude work"})
    out = compute_prior_agent_bridge(session, "claude", store)
    assert out == "[Previous from @claude]\nclaude work\n\n[Previous from @codex]\n<no output>"


def test_compute_prior_agent_bridge_includes_failed_run_tail() -> None:
    session = _session(
        [
            {
                "agent": "claude",
                "status": "failed",
                "exitCode": 2,
                "artifactIds": [],
                "agentLog": "command failed\nstack line\nfinal error",
            },
        ],
        [],
    )
    store = _FakeStore({})

    out = compute_prior_agent_bridge(session, "codex", store)

    assert out == "[Previous from @claude - failed, exit 2]\ncommand failed\nstack line\nfinal error"


def test_compute_prior_agent_bridge_keeps_own_earlier_run_for_handoff_continuity() -> None:
    session = _session(
        [
            {"agent": "codex", "artifactIds": ["old"]},
            {"agent": "claude", "artifactIds": ["mine"]},
            {"agent": "codex", "artifactIds": ["recent"]},
        ],
        [
            {"id": "old", "kind": "command_log"},
            {"id": "mine", "kind": "command_log"},
            {"id": "recent", "kind": "command_log"},
        ],
    )
    store = _FakeStore({"old": "● old work", "mine": "● my work", "recent": "● recent work"})
    out = compute_prior_agent_bridge(session, "claude", store)
    assert "[Previous from @codex]\nold work" in out
    assert "[Previous from @claude]\nmy work" in out
    assert "[Previous from @codex]\nrecent work" in out


def test_compute_prior_agent_bridge_chronological_multiple_runs() -> None:
    session = _session(
        [
            {"agent": "claude", "artifactIds": ["a"]},
            {"agent": "pi", "artifactIds": ["p"]},
            {"agent": "codex", "artifactIds": ["c"]},
        ],
        [
            {"id": "a", "kind": "command_log"},
            {"id": "p", "kind": "command_log"},
            {"id": "c", "kind": "command_log"},
        ],
    )
    store = _FakeStore({"a": "● a body", "p": "● p body", "c": "● c body"})
    out = compute_prior_agent_bridge(session, "claude", store)
    pi_idx = out.find("[Previous from @pi]")
    cx_idx = out.find("[Previous from @codex]")
    assert pi_idx >= 0 and cx_idx > pi_idx


def test_compute_prior_agent_bridge_only_uses_runs_after_latest_user_message() -> None:
    session = {
        "id": "sess_1",
        "createdAt": "2026-06-20T00:00:00.000Z",
        "taskGoal": "first turn",
        "events": [
            {
                "type": "user.message",
                "timestamp": "2026-06-20T00:02:00.000Z",
                "text": "follow up",
            }
        ],
        "agentRuns": [
            {
                "agent": "claude",
                "status": "completed",
                "completedAt": "2026-06-20T00:01:00.000Z",
                "artifactIds": ["old"],
            },
            {
                "agent": "pi",
                "status": "completed",
                "completedAt": "2026-06-20T00:03:00.000Z",
                "artifactIds": ["recent"],
            },
        ],
        "artifacts": [
            {"id": "old", "kind": "command_log"},
            {"id": "recent", "kind": "command_log"},
        ],
    }
    store = _FakeStore({"old": "● old answer", "recent": "● current-turn note"})

    out = compute_prior_agent_bridge(session, "codex", store)

    assert out == "[Previous from @pi]\ncurrent-turn note"
