from relay.services.task_workspace import (
    resolve_task_workspace,
    task_workspace_subpath,
)

TASK_CAPABLE_NODE = {"capabilities": ["thread-workspaces", "task-workspaces"]}
OLD_NODE = {"capabilities": ["thread-workspaces"]}


def test_backlog_task_gets_its_own_directory():
    assert task_workspace_subpath({"id": "tsk_one"}) == "tasks/tsk_one"


def test_routine_occurrence_nests_under_its_routine():
    occurrence = {"id": "tsk_run", "sourceRoutineId": "tsk_routine"}
    assert task_workspace_subpath(occurrence) == "tasks/tsk_routine/tsk_run"


def test_blank_source_routine_id_is_treated_as_absent():
    assert task_workspace_subpath({"id": "tsk_one", "sourceRoutineId": ""}) == "tasks/tsk_one"


def test_capable_node_resolves_to_the_task_layout():
    assert resolve_task_workspace({"id": "tsk_one"}, node=TASK_CAPABLE_NODE) == (
        "task",
        "tasks/tsk_one",
    )


def test_project_wins_over_the_task_workspace():
    snapshot = {"projectId": "prj_one", "workspaceSubpath": "projects/prj_one"}
    assert resolve_task_workspace(
        {"id": "tsk_one"}, node=TASK_CAPABLE_NODE, project_snapshot=snapshot
    ) == ("project", "projects/prj_one")


def test_new_task_requires_durable_workspace_support():
    import pytest
    with pytest.raises(ValueError, match="workspace_unavailable"):
        resolve_task_workspace({"id": "new"}, node=OLD_NODE)


def test_recorded_binding_wins_over_changed_project_membership():
    task = {"id": "one", "workspaceBinding": {
        "computerId": "node:one", "layout": "task", "subpath": "tasks/original",
    }}
    assert resolve_task_workspace(task, node={"id": "one", **TASK_CAPABLE_NODE},
        project_snapshot={"workspaceSubpath": "projects/new"}) == ("task", "tasks/original")


def test_binding_refuses_a_different_computer():
    import pytest
    task = {"id": "one", "workspaceBinding": {
        "computerId": "node:original", "layout": "task", "subpath": "tasks/one",
    }}
    with pytest.raises(ValueError, match="workspace_unavailable"):
        resolve_task_workspace(task, node={"id": "other", **TASK_CAPABLE_NODE})


def test_binding_survives_daemon_replacement_on_the_same_computer():
    task = {"id": "one", "workspaceBinding": {
        "computerId": "device:alice:machine", "layout": "task", "subpath": "tasks/one",
    }}
    node = {"id": "replacement", "employeeId": "alice", "workspaceId": "machine", **TASK_CAPABLE_NODE}
    assert resolve_task_workspace(task, node=node) == ("task", "tasks/one")
