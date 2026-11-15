"""Workspace priority decisions need no database or running scheduler."""

import pytest

from relay.core.workspace_scheduling import preferred_thread_id


def test_sendable_queue_keeps_the_last_executing_thread():
    assert preferred_thread_id({
        "id": "current", "messageQueue": {"messages": [{"id": "q1"}]},
    }, follow_up_admitted=False) == "current"


def test_consumed_message_keeps_priority_until_its_admitted_run_finishes():
    session = {"id": "current", "messageQueue": {"messages": []}}
    assert preferred_thread_id(session, follow_up_admitted=True) == "current"
    assert preferred_thread_id(session, follow_up_admitted=False) is None


@pytest.mark.parametrize("session", [
    None,
    {"id": "current", "archived": True},
    {"id": "current", "deletionRequestedAt": "now"},
])
def test_no_priority_for_missing_or_retired_thread(session):
    assert preferred_thread_id(session, follow_up_admitted=True) is None


def test_paused_queue_yields_to_the_next_task():
    assert preferred_thread_id({
        "id": "current", "messageQueue": {"messages": [{"id": "q1"}], "paused": True},
    }, follow_up_admitted=False) is None
