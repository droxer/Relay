from relay.services.task_workspace import (
    resolve_task_workspace,
    task_workspace_subpath,
)

TASK_CAPABLE_NODE = {"capabilities": ["thread-workspaces", "task-workspaces", "project-workspaces"]}
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


def test_recorded_legacy_thread_is_reused_even_on_an_old_daemon():
    from types import SimpleNamespace
    from relay.services.task_workspace import recorded_task_workspace, task_workspace_nodes
    node = {"id": "old", "employeeId": "alice", "workspaceId": "machine", **OLD_NODE}
    sessions = {"original": {"id": "original", "daemonNodeId": "old", "workspaceLayout": "thread"}}
    store = SimpleNamespace(get_session=lambda key: sessions[key])
    task = {"id": "task", "linkedSessionIds": ["original", "deleted"]}
    binding = recorded_task_workspace(task, store, [node])
    assert binding["sessionId"] == "original"
    assert binding["computerId"] == "device:alice:machine"
    assert resolve_task_workspace(task, node=node, session_store=store) == ("thread", None)
    assert task_workspace_nodes(task, [node, {"id": "unrelated"}], store) == [node]


def test_new_task_does_not_restrict_node_selection():
    from relay.services.task_workspace import task_workspace_nodes
    nodes = [{"id": "one"}, {"id": "two"}]
    assert task_workspace_nodes({"id": "task"}, nodes) == nodes


def test_legacy_managed_computer_identity_survives_missing_node():
    from types import SimpleNamespace
    from relay.services.task_workspace import recorded_task_workspace
    store = SimpleNamespace(get_session=lambda key: {"id": key, "managedNodeId": "managed", "workspaceLayout": "task", "workspaceSubpath": "tasks/original"})
    binding = recorded_task_workspace({"linkedSessionIds": ["session"]}, store)
    assert binding["computerId"] == "managed:managed"
    assert binding["subpath"] == "tasks/original"


def test_unrecoverable_history_or_changed_root_does_not_create_a_new_workspace():
    import pytest
    cases = [
        {"id": "one", "linkedSessionIds": ["deleted"]},
        {"id": "one", "workspaceBinding": {"computerId": "node:one", "layout": "task", "subpath": "tasks/one", "workspaceRoot": "/original"}},
        {"id": "one", "workspaceBinding": {"computerId": "node:one", "layout": "task"}},
    ]
    for task in cases:
        with pytest.raises(ValueError, match="workspace_unavailable"):
            resolve_task_workspace(task, node={"id": "one", "workspacePath": "/replacement", **TASK_CAPABLE_NODE})
    with pytest.raises(ValueError, match="workspace_unavailable"):
        resolve_task_workspace({"id": "new"}, node=None)
