from __future__ import annotations

from pathlib import Path

import pytest

from relay.persistence.session_store import DatabaseSessionStore, LocalSessionStore
from relay.sessions import compute_prior_handoff_note
from relay.sessions.controller import SessionArchivedError, SessionController


def test_compute_prior_handoff_note_requires_latest_decision_to_be_handoff() -> None:
    session = {
        "id": "ses_1",
        "createdAt": "2026-06-20T00:00:00.000Z",
        "events": [
            {
                "type": "human.decision",
                "timestamp": "2026-06-20T00:01:00.000Z",
                "decision": {
                    "kind": "handoff",
                    "targetAgent": "codex",
                    "note": "verify the fix",
                },
            },
            {
                "type": "human.decision",
                "timestamp": "2026-06-20T00:02:00.000Z",
                "decision": {
                    "kind": "rerun",
                    "targetAgent": "codex",
                },
            },
        ],
    }

    assert compute_prior_handoff_note(session, "codex") is None


def test_compute_prior_handoff_note_returns_latest_handoff_note() -> None:
    session = {
        "id": "ses_1",
        "createdAt": "2026-06-20T00:00:00.000Z",
        "events": [
            {
                "type": "human.decision",
                "timestamp": "2026-06-20T00:01:00.000Z",
                "decision": {
                    "kind": "handoff",
                    "targetAgent": "codex",
                    "note": "  verify the fix  ",
                },
            },
        ],
    }

    assert (
        compute_prior_handoff_note(session, "codex") == "[Handoff note]\nverify the fix"
    )


def test_compute_prior_handoff_note_targets_a_logical_agent() -> None:
    session = {
        "id": "ses_1",
        "createdAt": "2026-06-20T00:00:00.000Z",
        "events": [
            {
                "type": "human.decision",
                "timestamp": "2026-06-20T00:01:00.000Z",
                "decision": {
                    "kind": "handoff",
                    "targetAgent": "codex",
                    "targetAgentId": "agent_reviewer",
                    "note": "verify the fix",
                },
            },
        ],
    }

    assert (
        compute_prior_handoff_note(session, "codex", "agent_reviewer")
        == "[Handoff note]\nverify the fix"
    )
    assert compute_prior_handoff_note(session, "codex", "agent_builder") is None
    assert compute_prior_handoff_note(session, "codex") is None


def test_rejected_handoff_does_not_append_a_decision(tmp_path: Path) -> None:
    store = LocalSessionStore(tmp_path)
    controller = SessionController(store, owner_employee_id="alice")
    session = controller.create_session("Fix auth", ["human", "claude"])
    controller.archive_session(session["id"])

    with pytest.raises(SessionArchivedError):
        controller.handoff_session(
            session["id"],
            "codex",
            [{"agent": "codex"}],
            "verify the fix",
        )

    assert store.get_session(session["id"])["decisions"] == []


@pytest.mark.parametrize("failure_phase", ["assigned", "handoff:codex"])
def test_handoff_rolls_back_all_writes_and_can_be_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure_phase: str
) -> None:
    store = DatabaseSessionStore(f"sqlite:///{tmp_path}/handoff.db", create_schema=True)
    controller = SessionController(store, owner_employee_id="alice")
    session = controller.create_session("Fix auth", ["human", "claude"])
    session_id = session["id"]
    before = store.get_session(session_id)
    append_event = store.append_event

    def fail_status(session_id, event):
        if (
            event.get("type") == "session.status"
            and event.get("phase") == failure_phase
        ):
            raise RuntimeError("injected handoff persistence failure")
        return append_event(session_id, event)

    with monkeypatch.context() as patch:
        patch.setattr(store, "append_event", fail_status)
        with pytest.raises(RuntimeError, match="injected handoff persistence failure"):
            controller.handoff_session(
                session_id,
                "codex",
                [{"agent": "codex"}],
                "verify the fix",
                decision_id="dec_retry",
            )

    assert store.get_session(session_id) == before
    result = controller.handoff_session(
        session_id,
        "codex",
        [{"agent": "codex"}],
        "verify the fix",
        decision_id="dec_retry",
    )
    assert result["phase"] == "handoff:codex"
    assert len(result["decisions"]) == 1
    assert len(result["artifacts"]) == 1
    assert (
        controller.handoff_session(
            session_id,
            "codex",
            [{"agent": "codex"}],
            "verify the fix",
            decision_id="dec_retry",
        )
        == result
    )
