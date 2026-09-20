import asyncio
from datetime import date
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from relay.services import task_dispatch


@pytest.mark.parametrize(
    "session_status", ["completed", "failed", "cancelled", "missing", "running"]
)
def test_routine_retry_dispatches_only_without_a_live_session(monkeypatch, session_status):
    occurrence = {"id": "occ", "status": "assigned", "linkedSessionIds": ["old"]}
    routine = {
        "id": "routine", "isRoutine": True, "routineEnabled": True,
        "linkedSessionIds": ["old"],
    }
    session_store = Mock()
    session_store.get_session.return_value = {"id": "old", "status": session_status}
    if session_status == "missing":
        session_store.get_session.side_effect = KeyError("old")
    ctx = SimpleNamespace(task_store=Mock(), session_store=session_store)
    monkeypatch.setattr(task_dispatch, "active_routine_occurrence", lambda *_: occurrence)
    monkeypatch.setattr(task_dispatch, "routine_next_run_date", lambda *_: None)
    dispatch = AsyncMock(return_value={
        "task": occurrence, "session": {"id": "new"},
        "dispatch": {"state": "started"},
    })
    monkeypatch.setattr(task_dispatch, "start_task_on_ready_node", dispatch)

    result = asyncio.run(
        task_dispatch.start_routine_occurrence_on_ready_node(
            ctx, routine, {}, agent=None, run_date=date.today()
        )
    )

    if session_status == "running":
        dispatch.assert_not_awaited()
        assert result["session"]["id"] == "old"
    else:
        dispatch.assert_awaited_once_with(ctx, occurrence, {}, assignments=None, retry_blocked=False)
        assert result["session"]["id"] == "new"
        ctx.task_store.link_session.assert_called_once_with("routine", "new")


@pytest.mark.parametrize(
    "assignment", [{"assignedTeamId": "team"}, {"projectId": "project"}]
)
@pytest.mark.parametrize("active_source", ["claim", "task_request", "session_request"])
def test_queued_execution_guard_precedes_assignment_resolution(assignment, active_source):
    task = {"id": "task", "status": "assigned", **assignment}
    if active_source == "claim":
        task["dispatchClaim"] = {"id": "claim", "expiresAt": "2999-01-01T00:00:00Z"}
    else:
        task["linkedSessionIds"] = ["session"]
    daemon_store = Mock()
    daemon_store.active_run_request_for_task.return_value = (
        {"id": "request"} if active_source == "task_request" else None
    )
    daemon_store.active_run_request_for_session_any_node.return_value = (
        {"id": "request"} if active_source == "session_request" else None
    )
    ctx = SimpleNamespace(
        task_store=Mock(), session_store=Mock(),
        registry=SimpleNamespace(daemon_store=daemon_store),
    )
    dispatcher = task_dispatch.TaskDispatcher(
        ctx, task, {}, assignments=None, record_pending=True
    )
    dispatcher._resolve_project_assignments = Mock(
        side_effect=AssertionError("must not resolve")
    )
    dispatcher._resolve_team_assignments = Mock(
        side_effect=AssertionError("must not resolve")
    )

    result = asyncio.run(dispatcher.start())

    assert result["dispatch"]["code"] == "task_execution_active"
    assert result["task"] == task
    assert ctx.task_store.mock_calls == []
