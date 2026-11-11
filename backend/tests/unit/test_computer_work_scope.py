from relay.tasks.issue_triage import issue_needs_project
from relay.tasks.workspace import task_workspace_nodes
from relay.persistence.task.events import task_creation_events


def test_computer_tasks_are_work_and_remain_on_their_computer():
    task = {"id": "t", "computerId": "node:a"}
    assert not issue_needs_project(task)
    assert task_workspace_nodes(task, [{"id": "a"}, {"id": "b"}]) == [{"id": "a"}]


def test_computer_scope_survives_event_replay():
    events = task_creation_events("t", {"title": "Work", "computerId": "node:a"})
    assert events[0].get("computerId") == "node:a"


def test_automation_occurrences_inherit_the_computer_scope():
    from relay.persistence.task.events import routine_occurrence_events
    from relay.persistence.task.reducer import materialize_task_events
    events = routine_occurrence_events({"id": "automation", "title": "Repeat", "computerId": "node:a"}, None, scheduled_for="2026-11-11")
    task = materialize_task_events(events)
    assert task["computerId"] == "node:a"
