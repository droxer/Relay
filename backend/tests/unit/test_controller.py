from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest

from relay.persistence.session_store import LocalSessionStore
from relay.sessions import SessionController, initial_agent_state


def test_local_controller_leaves_linked_task_without_explicit_task_id() -> None:
    from relay.persistence.task_store import LocalTaskStore

    with TemporaryDirectory() as root:
        sessions = LocalSessionStore(root)
        tasks = LocalTaskStore(root)
        session = SessionController(sessions).create_session("Legacy thread")
        task = tasks.create_task({"title": "Legacy task"})
        tasks.link_session(task["id"], session["id"])
        controller = SessionController(sessions, task_store=tasks)

        controller.record_decision(session["id"], "mark_done")

        assert tasks.get_task(task["id"])["status"] == task["status"]
        assert sessions.get_session(session["id"])["status"] == "completed"
        assert sessions.get_session(session["id"])["workOutcome"] == "accepted"


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


def test_successful_final_turn_keeps_task_running_until_round_closes() -> None:
    """The round's own closeout picks the next status; the turn must not
    report a waiting_for_human stop that automations would then react to."""
    from relay.persistence.task_store import LocalTaskStore

    with TemporaryDirectory() as root:
        sessions = LocalSessionStore(root)
        tasks = LocalTaskStore(root)
        task = tasks.create_task({"title": "Ship it", "acceptancePolicy": "automatic"})
        controller = SessionController(sessions, task_store=tasks, task_id=task["id"])
        session = controller.create_session("Ship it")
        controller.record_agent_started(session["id"], {"runId": "run_1", "agent": "codex"})
        controller.record_agent_completed(session["id"], initial_agent_state("Ship it"), {
            "runId": "run_1", "agent": "codex", "status": "completed", "exitCode": 0,
        })

        assert tasks.get_task(task["id"])["status"] == "running"
        controller.complete_session(session["id"], "Assignments completed.")

        statuses = [
            event["status"] for event in tasks.get_task(task["id"])["events"]
            if event["type"] == "task.status"
        ]
        assert statuses == ["running", "done"]


def test_complete_session_retry_is_a_no_op() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        controller = SessionController(store, workspace_path="/workspace")
        session = controller.create_session("finish once")

        controller.complete_session(session["id"], "Done.")
        again = controller.complete_session(session["id"], "Done.")

        completions = [e for e in again["events"] if e["type"] == "session.completed"]
        assert len(completions) == 1


def test_approving_a_rejected_turn_settles_the_thread() -> None:
    """Nothing dispatches after an approval, so it must not claim a live run."""
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        controller = SessionController(store, workspace_path="/workspace")
        session = controller.create_session("draft")
        controller.complete_session(session["id"], "Draft written.")
        controller.record_decision(session["id"], "reject")

        approved = controller.record_decision(session["id"], "approve")

        assert approved["status"] == "completed"
        assert "pendingDecision" not in approved
        assert [d["kind"] for d in approved["decisions"]] == ["reject", "approve"]


def test_approving_a_running_thread_keeps_it_running() -> None:
    with TemporaryDirectory() as root:
        store = LocalSessionStore(root)
        controller = SessionController(store, workspace_path="/workspace")
        session = controller.create_session("in flight")

        assert controller.record_decision(session["id"], "approve")["status"] == "running"


@pytest.mark.parametrize("policy,task_status,expected", [
    ("automatic", "done", "done"),
    ("human", "done", "review"),
    ("automatic", "waiting_for_human", "waiting_for_human"),
])
def test_completion_retry_repairs_partial_task_write(
    monkeypatch, policy, task_status, expected,
) -> None:
    from relay.persistence.task_store import LocalTaskStore
    from relay.persistence.store_common import relay_task_event

    with TemporaryDirectory() as root:
        sessions, tasks = LocalSessionStore(root), LocalTaskStore(root)
        task = tasks.create_task({"title": "Finish", "acceptancePolicy": policy})
        controller = SessionController(sessions, task_store=tasks, task_id=task["id"])
        session = controller.create_session("Finish")
        tasks.append_event(task["id"], relay_task_event("task.status", task["id"], {"status": "running"}))
        with monkeypatch.context() as patch:
            def fail_task_write(*args, **kwargs):
                raise OSError("task write failed")

            patch.setattr(tasks, "append_event", fail_task_write)
            with pytest.raises(OSError):
                controller.complete_session(session["id"], "Done.", task_status=task_status)
        controller.complete_session(session["id"], "Done.", task_status=task_status)
        assert tasks.get_task(task["id"])["status"] == expected
        before = tasks.get_task(task["id"])
        again = controller.complete_session(session["id"], "Done.", task_status=task_status)
        assert tasks.get_task(task["id"]) == before
        assert len([e for e in again["events"] if e["type"] == "session.completed"]) == 1


@pytest.mark.parametrize("claimed", [False, True])
def test_completion_retry_does_not_overwrite_newer_execution(monkeypatch, claimed) -> None:
    from relay.persistence.task_store import LocalTaskStore
    from relay.persistence.store_common import relay_task_event

    with TemporaryDirectory() as root:
        sessions, tasks = LocalSessionStore(root), LocalTaskStore(root)
        task = tasks.create_task({"title": "Finish", "acceptancePolicy": "automatic"})
        if claimed:
            task = tasks.append_event(task["id"], relay_task_event(
                "task.execution.claimed", task["id"], {"requestId": "first", "expectedRevision": 0},
            ))
        controller = SessionController(sessions, task_store=tasks, task_id=task["id"],
                                       task_execution_owner=task.get("executionOwner"))
        session = controller.create_session("Finish")
        with monkeypatch.context() as patch:
            def fail_task_write(*args, **kwargs):
                raise OSError("task write failed")

            patch.setattr(tasks, "append_event", fail_task_write)
            with pytest.raises(OSError):
                controller.complete_session(session["id"], "Done.")
        tasks.append_event(task["id"], relay_task_event(
            "task.execution.claimed", task["id"], {"requestId": "new", "expectedRevision": 1 if claimed else 0},
        ))
        tasks.append_event(task["id"], relay_task_event("task.status", task["id"], {"status": "running"}))
        before = tasks.get_task(task["id"])
        controller.complete_session(session["id"], "Done.")
        assert tasks.get_task(task["id"]) == before
