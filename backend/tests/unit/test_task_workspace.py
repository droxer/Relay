from relay.tasks.workspace import (
    resolve_task_workspace,
    task_artifacts_dir,
    task_workspace_subpath,
    workspace_artifacts_dir,
)

TASK_CAPABLE_NODE = {"capabilities": ["thread-workspaces", "task-workspaces", "project-workspaces"]}
LAYOUT_NODE = {"capabilities": [*TASK_CAPABLE_NODE["capabilities"], "artifact-layout"]}
OLD_NODE = {"capabilities": ["thread-workspaces"]}
OCCURRENCE = {"id": "tsk_run", "sourceRoutineId": "tsk_routine"}


def test_backlog_task_gets_its_own_directory():
    assert task_workspace_subpath({"id": "tsk_one"}) == "tasks/tsk_one"


def test_routine_occurrences_share_their_automation_directory():
    assert task_workspace_subpath(OCCURRENCE) == "tasks/tsk_routine"


def test_a_daemon_without_artifact_layout_keeps_one_directory_per_occurrence():
    assert task_workspace_subpath(OCCURRENCE, shared_automation=False) == "tasks/tsk_routine/tsk_run"
    assert resolve_task_workspace(OCCURRENCE, node=TASK_CAPABLE_NODE) == ("task", "tasks/tsk_routine/tsk_run")
    assert resolve_task_workspace(OCCURRENCE, node=LAYOUT_NODE) == ("task", "tasks/tsk_routine")


def test_artifacts_follow_the_workspace_scope():
    # A thread or backlog task keeps `artifacts/`.
    assert workspace_artifacts_dir("thread", None) == "artifacts"
    assert workspace_artifacts_dir("task", "tasks/tsk_one", task={"id": "tsk_one"}) == "artifacts"
    # Each automation run keeps its own folder under the shared automation directory.
    assert workspace_artifacts_dir("task", "tasks/tsk_routine", task=OCCURRENCE) == "artifacts/tsk_run"
    # An occurrence bound before the shared layout keeps its own `artifacts/`.
    assert workspace_artifacts_dir("task", "tasks/tsk_routine/tsk_run", task=OCCURRENCE) == "artifacts"
    # A project directory is the deliverable location; there is no `artifacts/`.
    assert workspace_artifacts_dir("project", "projects/prj_one", task={"id": "tsk_one"}) is None


def test_task_artifacts_dir_reads_the_binding_else_predicts_the_layout():
    bound = {**OCCURRENCE, "workspaceBinding": {"layout": "task", "subpath": "tasks/tsk_routine"}}
    assert task_artifacts_dir(bound) == "artifacts/tsk_run"
    legacy = {**OCCURRENCE, "workspaceBinding": {"layout": "task", "subpath": "tasks/tsk_routine/tsk_run"}}
    assert task_artifacts_dir(legacy) == "artifacts"
    assert task_artifacts_dir(OCCURRENCE) == "artifacts/tsk_run"
    assert task_artifacts_dir({"id": "tsk_one"}) == "artifacts"
    assert task_artifacts_dir({"id": "tsk_one", "projectId": "prj_one"}) is None
    assert task_artifacts_dir({"id": "tsk_one", "workspaceBinding": {"layout": "project", "subpath": "links/repo"}}) is None


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


def test_linked_project_requires_link_support_for_new_and_recorded_workspaces():
    import pytest
    node = {"id": "one", **TASK_CAPABLE_NODE}
    snapshot = {"workspaceSubpath": "links/repo"}
    tasks = [
        {"id": "new"},
        {"id": "old", "workspaceBinding": {
            "computerId": "node:one", "layout": "project", "subpath": "links/repo",
        }},
    ]
    for task in tasks:
        with pytest.raises(ValueError, match="project-links"):
            resolve_task_workspace(task, node=node, project_snapshot=snapshot)
        assert resolve_task_workspace(
            task, node={**node, "capabilities": [*node["capabilities"], "project-links"]},
            project_snapshot=snapshot,
        ) == ("project", "links/repo")


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
    node = {"id": "replacement", "userId": "alice", "workspaceId": "machine", **TASK_CAPABLE_NODE}
    assert resolve_task_workspace(task, node=node) == ("task", "tasks/one")


def test_recorded_legacy_thread_is_reused_even_on_an_old_daemon():
    from types import SimpleNamespace
    from relay.tasks.workspace import recorded_task_workspace, task_workspace_nodes
    node = {"id": "old", "userId": "alice", "workspaceId": "machine", **OLD_NODE}
    sessions = {"original": {"id": "original", "daemonNodeId": "old", "workspaceLayout": "thread"}}
    store = SimpleNamespace(get_session=lambda key: sessions[key])
    task = {"id": "task", "linkedSessionIds": ["original", "deleted"]}
    binding = recorded_task_workspace(task, store, [node])
    assert binding["sessionId"] == "original"
    assert binding["computerId"] == "device:alice:machine"
    assert resolve_task_workspace(task, node=node, session_store=store) == ("thread", None)
    assert task_workspace_nodes(task, [node, {"id": "unrelated"}], store) == [node]


def test_new_task_does_not_restrict_node_selection():
    from relay.tasks.workspace import task_workspace_nodes
    nodes = [{"id": "one"}, {"id": "two"}]
    assert task_workspace_nodes({"id": "task"}, nodes) == nodes


def test_legacy_managed_computer_identity_survives_missing_node():
    from types import SimpleNamespace
    from relay.tasks.workspace import recorded_task_workspace
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


def test_unstarted_thread_can_choose_its_first_computer_but_executed_history_cannot():
    from types import SimpleNamespace
    import pytest
    from relay.tasks.workspace import task_workspace_nodes

    node = {"id": "first", **OLD_NODE}
    session = {"id": "pending", "status": "running", "agentRuns": []}
    store = SimpleNamespace(get_session=lambda _: session)
    task = {"id": "task", "linkedSessionIds": ["pending"]}
    assert task_workspace_nodes(task, [node], store) == [node]
    assert resolve_task_workspace(task, node=node, session_store=store) == ("node-root", None)
    session["agentRuns"] = [{"id": "old-run", "status": "completed"}]
    assert task_workspace_nodes(task, [node], store) == []
    with pytest.raises(ValueError, match="workspace_unavailable"):
        resolve_task_workspace(task, node=node, session_store=store)
