import pytest
from relay.daemon_registry.dispatch.run_start import _run_start_command


@pytest.mark.parametrize("project,task,automation,layout,path", [
    (None, None, None, "thread", None),
    (None, "task", None, "task", "tasks/task"),
    (None, "run", "automation", "task", "tasks/automation"),
    ("project", "task", None, "project", "projects/project"),
])
def test_run_scope_is_built_from_authoritative_records(project, task, automation, layout, path):
    command = _run_start_command(
        run_request={"id": "request", "sessionId": "thread", "taskGoal": "Work", **({"taskId": task} if task else {})},
        assignment={"executorKind": "codex", "assignmentId": "assignment"},
        sandbox={"id": "node", "userId": "owner", "workspaceId": "host"},
        session_snapshot={**({"projectId": project} if project else {}), "workspaceSubpath": path},
        node_id="node", run_id="run", state={"team_phase": "execution", "workspace_scope": {"computerId": "forged"}},
        role=None, workspace_layout=layout, artifacts_dir=None, context=None, handoff_validation=None,
        task_snapshot={"sourceRoutineId": automation} if automation else None,
    )
    assert command["workspaceScope"] == {
        "computerId": "device:owner:host", **({"projectId": project} if project else {}),
        **({"taskId": task} if task else {}), **({"automationId": automation} if automation else {}),
    }


@pytest.mark.parametrize("layout", ["thread", "task", "project", "node-root"])
def test_delivery_refuses_daemons_without_scope_enforcement(layout):
    from relay.daemon_registry.dispatch.run_state import _check_workspace_support
    from relay.daemon_registry.dispatch.run_start import _DeliveryRefused
    with pytest.raises(_DeliveryRefused, match="workspace-scope"):
        _check_workspace_support({"capabilities": ["thread-workspaces", "task-workspaces", "project-workspaces"]}, layout, "tasks/t")


@pytest.mark.parametrize("layout,task", [("node-root", None), ("node-root", "t"), ("thread", "t")])
def test_legacy_scope_is_explicitly_authorized_by_backend(layout, task):
    command = _run_start_command(
        run_request={"id": "request", "sessionId": "s", "taskGoal": "Work", **({"taskId": task} if task else {})},
        assignment={"executorKind": "codex", "assignmentId": "a"}, sandbox={"id": "n", "userId": "owner", "workspaceId": "host"},
        session_snapshot={}, node_id="n", run_id="r", state={"team_phase": "execution"},
        role=None, workspace_layout=layout, artifacts_dir=None, context=None, handoff_validation=None,
    )
    assert command["workspaceScope"]["legacyLayout"] == layout


@pytest.mark.parametrize("task,automation", [(None, None), ("task", None), ("occurrence", "automation")])
def test_linked_project_scope_carries_the_recorded_directory(task, automation):
    command = _run_start_command(
        run_request={"id": "request", "sessionId": "thread", "taskGoal": "Work", **({"taskId": task} if task else {})},
        assignment={"executorKind": "pi", "assignmentId": "assignment"},
        sandbox={"id": "node", "userId": "owner", "workspaceId": "host"},
        session_snapshot={"projectId": "project", "workspaceSubpath": "links/independent-link"},
        node_id="node", run_id="run",
        state={"team_phase": "execution", "workspace_scope": {"projectWorkspaceSubpath": "links/forged"}},
        role=None, workspace_layout="project", artifacts_dir=None, context=None, handoff_validation=None,
        task_snapshot={"sourceRoutineId": automation} if automation else None,
    )
    assert command["workspaceScope"]["projectId"] == "project"
    assert command["workspaceScope"]["projectWorkspaceSubpath"] == command["workspaceSubpath"] == "links/independent-link"


def test_linked_projects_require_the_fixed_scope_contract():
    from relay.daemon_registry.dispatch.run_state import _check_workspace_support
    from relay.daemon_registry.dispatch.run_start import _DeliveryRefused
    old_client = {"capabilities": ["workspace-scope", "project-workspaces", "project-links"]}
    # Canonical Projects remain compatible; independently named links need the fix.
    _check_workspace_support(old_client, "project", "projects/project")
    with pytest.raises(_DeliveryRefused, match="project-workspace-scope"):
        _check_workspace_support(old_client, "project", "links/independent-link")
    _check_workspace_support(
        {"capabilities": [*old_client["capabilities"], "project-workspace-scope"]},
        "project", "links/independent-link",
    )
