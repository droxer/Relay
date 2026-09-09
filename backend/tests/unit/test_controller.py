from __future__ import annotations

from tempfile import TemporaryDirectory

from relay.persistence.session_store import LocalSessionStore
from relay.sessions import SessionController, initial_agent_state


def test_local_controller_completes_linked_task_without_explicit_task_id() -> None:
    from relay.persistence.task_store import LocalTaskStore

    with TemporaryDirectory() as root:
        sessions = LocalSessionStore(root)
        tasks = LocalTaskStore(root)
        session = SessionController(sessions).create_session("Legacy thread")
        task = tasks.create_task({"title": "Legacy task"})
        tasks.link_session(task["id"], session["id"])
        controller = SessionController(sessions, task_store=tasks)

        controller.record_decision(session["id"], "mark_done")

        assert tasks.get_task(task["id"])["status"] == "done"
        assert sessions.get_session(session["id"])["status"] == "completed"


def test_session_controller_records_review_run() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        controller = SessionController(store, workspace_path="/workspace")
        session = controller.create_session("review diff")
        state = initial_agent_state("review diff")
        controller.record_agent_started(session["id"], {"runId": "run_1", "agent": "codex"})
        state = controller.record_agent_completed(session["id"], state, {
            "runId": "run_1",
            "agent": "codex",
            "status": "completed",
            "exitCode": 0,
            "agentLog": "looks fine",
            "tokenUsage": {"input": 9, "output": 4, "cache": 2, "total": 15, "source": "codex"},
        })

        updated = store.get_session(session["id"])
        assert "review_verdict" not in state
        assert state["token_usage"]["total"] == 15
        assert "reviewVerdict" not in updated
        assert updated["agentRuns"][0]["tokenUsage"]["input"] == 9
        assert updated["tokenUsage"]["total"] == 15
        assert updated["agentRuns"][0]["artifactIds"] == []
        assert updated["agentRuns"][0]["agentLog"] == "looks fine"
        assert "role" not in updated["agentRuns"][0]
        assert updated["artifacts"] == []
        assert all(event["type"] != "review.verdict" for event in updated["events"])


def test_record_cancel_decision_appends_one_cancel_decision() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        controller = SessionController(store, workspace_path="/workspace")
        session = controller.create_session("cancel this")

        updated = controller.record_decision(session["id"], "cancel", "No longer needed.")

        assert updated["status"] == "cancelled"
        assert [decision["kind"] for decision in updated["decisions"]] == ["cancel"]


def test_record_user_message_appends_event_with_given_id() -> None:
    from relay.sessions import SessionController, initial_agent_state  # noqa: F401
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        controller = SessionController(store, workspace_path="/workspace")
        session = controller.create_session("first turn")
        controller.record_user_message(session["id"], "second turn", message_id="evt_fixed")
        updated = store.get_session(session["id"])
        user_events = [e for e in updated["events"] if e["type"] == "user.message"]
        assert len(user_events) == 1
        assert user_events[0]["id"] == "evt_fixed"
        assert user_events[0]["text"] == "second turn"


def test_collaboration_round_is_materialized_as_authoritative_session_state() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        controller = SessionController(store, workspace_path="/workspace")
        session = controller.create_session("ship it")
        manifest = {
            "collaborationId": "col_1",
            "roundId": "round_1",
            "source": "message",
            "purpose": "accomplish",
            "strategy": "coordinate",
            "address": {"kind": "room"},
            "assignments": [{"assignmentId": "assignment_1", "agentId": "agent_1"}],
            "completionPolicy": "assigned_work",
        }

        updated = controller.record_collaboration_round_started(session["id"], manifest)

        assert updated["collaborationRounds"] == [manifest]
        assert updated["activeCollaborationId"] == "col_1"
        assert updated["activeRoundId"] == "round_1"
        assert updated["collaborationRevision"] == 1


def test_compute_conversation_history_excludes_current_turn() -> None:
    from relay.sessions import compute_conversation_history
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        controller = SessionController(store, workspace_path="/workspace")
        session = controller.create_session("first turn")
        # No prior turns yet beyond the current goal -> nothing to show.
        assert compute_conversation_history(store.get_session(session["id"]), store) is None
        controller.record_agent_started(session["id"], {"runId": "run_1", "agent": "claude"})
        controller.record_agent_output(session["id"], "run_1", "claude", "stdout", "● answer one")
        controller.record_agent_completed(
            session["id"],
            initial_agent_state("first turn"),
            {"runId": "run_1", "agent": "claude", "status": "completed", "exitCode": 0, "agentLog": "● answer one"},
        )
        controller.record_user_message(session["id"], "second turn")
        history = compute_conversation_history(store.get_session(session["id"]), store)
        assert history is not None
        assert "[Conversation so far]" in history
        assert "first turn" in history
        assert "answer one" in history
        # The current (latest) turn must not be duplicated into the history.
        assert "second turn" not in history
