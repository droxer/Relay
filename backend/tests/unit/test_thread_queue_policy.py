"""The workspace handoff and message consumer share the same human-wait gate."""

import pytest

from relay.core.thread_queue import queue_can_continue


@pytest.mark.parametrize("held", [
    {"pendingDecision": "approve"},
    {"inputQuestion": "which branch?"},
    {"permissionRequests": [{"id": "permission"}]},
    {"status": "waiting_for_human"},
    {"workOutcome": "blocked"},
])
def test_human_waits_release_priority_until_explicit_send(held):
    session = {"messageQueue": {"messages": [{"id": "q1"}], "paused": False}, **held}
    assert not queue_can_continue(session)
    session["messageQueue"]["sendRequested"] = True
    assert queue_can_continue(session)


@pytest.mark.parametrize("held", [
    {"archived": True}, {"deletionRequestedAt": "now"},
])
def test_explicit_send_cannot_resume_retired_thread(held):
    assert not queue_can_continue({
        "messageQueue": {"messages": [{"id": "q1"}], "sendRequested": True}, **held,
    })
