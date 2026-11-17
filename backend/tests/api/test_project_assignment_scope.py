"""Standalone and Project work keep their assignment scopes apart.

Standalone Tasks and Automations name Agents or ordinary Teams, including
Project members. Project
Tasks and Automations name an enabled roster Agent or a Workflow owned by that
same Project. A Team is never a Project Task/Automation assignment, and a saved
assignment that no longer fits is blocked before any daemon command exists.

The Team escape hatches stay: event-trigger observation filters may name a
Team, and a Team can still run a Workflow directly.
"""
# ruff: noqa: F811 -- imported pytest fixture is injected by parameter name.
import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from automation_helpers import DAILY_TRIGGERS, WEEKLY_TRIGGERS
from relay.core.computer_identity import computer_id
from test_project_execution_policy import project_context  # noqa: F401
from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer, _team
from fastapi.testclient import TestClient

from relay.app import create_app

PROJECT_TEAM_FORBIDDEN = "project_team_assignment_forbidden"


@pytest.fixture
def scope_context(monkeypatch, tmp_path):
    """One project (lead + worker), a second project, and an independent agent."""
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_scope", "scope-computer")
    # Dispatch needs the workspace and workflow-result capabilities a current
    # daemon advertises; the shared helper registers only the older set.
    node = app.state.registry.register({
        **node, "sandboxId": node["id"], "token": f"token_{node['id']}",
        "protocolVersion": 1, "supportedAgents": ["codex", "claude"],
        "capabilities": [*node["capabilities"], "task-workspaces", "round-result",
                         "workflow-results"],
    })
    lead = _agent(client, app, node, "Lead", "codex")
    worker = _agent(client, app, node, "Worker", "claude")
    outsider = _agent(client, app, node, "Outsider", "claude")
    neighbour = _agent(client, app, node, "Neighbour", "codex")
    _login_alice(client)
    project = _project(client, node, lead, worker, name="Scope project")
    other = _project(client, node, neighbour, name="Other project")
    return app, client, node, project, other, lead, worker, outsider


def _project(client, node, lead, *members, name="Scope project"):
    response = client.post("/api/v1/projects", json={
        "name": name, "daemonNodeId": node["id"], "leadAgentId": lead["id"],
        "members": [
            {"agentId": agent["id"], "role": "implementer", "responsibilities": "Deliver",
             "enabled": True}
            for agent in (lead, *members)
        ],
    })
    assert response.status_code == 201, response.text
    return response.json()["project"]


def _step(agent_id, step_id="design"):
    return {"id": step_id, "name": step_id.title(), "agentId": agent_id,
            "instructions": "Do the work", "acceptanceCriteria": ["Reviewed"]}


def _workflow(client, project, agent_id, *, name="Delivery"):
    response = client.post("/api/v1/workflows", json={
        "name": name, "projectId": project["id"], "workflowSteps": [_step(agent_id)],
    })
    assert response.status_code == 201, response.text
    return response.json()["workflow"]


def _standalone_payload(title="Independent work", *, routine=False, node=None):
    # Standalone work is computer-scoped: no Project, but never workspace-less.
    payload = {"title": title, "computerId": computer_id(node)}
    if routine:
        payload.update(isRoutine=True, routineState="paused", routineTriggers=WEEKLY_TRIGGERS)
    return payload


def _project_payload(project, title="Project work", *, routine=False):
    payload = {"title": title, "projectId": project["id"]}
    if routine:
        payload.update(isRoutine=True, routineState="paused", routineTriggers=WEEKLY_TRIGGERS)
    return payload


def _create_with(client, payload, field, value):
    return client.post("/api/v1/tasks", json={**payload, field: value})


def _assert_saved(client, task_id, field, value, response):
    """A refused edit leaves the saved assignment exactly as it was."""
    saved = client.get(f"/api/v1/tasks/{task_id}").json()
    if response.status_code < 400:
        assert saved.get(field) == value, saved
    else:
        assert not saved.get(field), saved


def _patch_with(client, payload, field, value):
    created = client.post("/api/v1/tasks", json=payload)
    assert created.status_code == 201, created.text
    task_id = created.json()["id"]
    response = client.patch(f"/api/v1/tasks/{task_id}", json={field: value})
    _assert_saved(client, task_id, field, value, response)
    return response


def _put_assignment(client, payload, field, value):
    created = client.post("/api/v1/tasks", json=payload)
    assert created.status_code == 201, created.text
    task_id = created.json()["id"]
    response = client.put(f"/api/v1/tasks/{task_id}/assignment", json={field: value})
    saved_field = "assignedAgentId" if field == "agentId" else "assignedTeamId"
    _assert_saved(client, task_id, saved_field, value, response)
    return response


def _assert_refused(response, status, detail):
    assert response.status_code == status, response.text
    assert response.json()["detail"] == detail


# --- Project scope -----------------------------------------------------------


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("entry", ["create", "patch", "assignment"])
@pytest.mark.parametrize("membership", ["absent", "disabled"])
def test_project_refuses_an_agent_outside_its_enabled_roster(scope_context, routine, entry, membership):
    _, client, _, project, _, _, worker, outsider = scope_context
    agent = outsider
    if membership == "disabled":
        agent = worker
        changed = client.patch(f"/api/v1/projects/{project['id']}", json={
            "expectedVersion": project["version"],
            "members": [{**member, "enabled": member["agentId"] != worker["id"]}
                        for member in project["members"]],
        })
        assert changed.status_code == 200, changed.text
    payload = _project_payload(project, routine=routine)
    if entry == "create":
        response = _create_with(client, payload, "assignedAgentId", agent["id"])
    elif entry == "patch":
        response = _patch_with(client, payload, "assignedAgentId", agent["id"])
    else:
        response = _put_assignment(client, payload, "agentId", agent["id"])
    _assert_refused(response, 400, "project_agent_not_member")


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("entry", ["create", "patch", "assignment"])
def test_project_refuses_direct_team_assignment(scope_context, routine, entry):
    _, client, _, project, _, lead, worker, _ = scope_context
    team = _team(client, lead, worker, name="Crew")
    payload = _project_payload(project, routine=routine)
    if entry == "create":
        response = _create_with(client, payload, "assignedTeamId", team["id"])
    elif entry == "patch":
        response = _patch_with(client, payload, "assignedTeamId", team["id"])
    else:
        response = _put_assignment(client, payload, "teamId", team["id"])
    _assert_refused(response, 400, PROJECT_TEAM_FORBIDDEN)


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("entry", ["create", "patch"])
def test_project_refuses_a_workflow_owned_by_another_project(scope_context, routine, entry):
    _, client, _, project, other, _, _, _ = scope_context
    foreign = _workflow(client, other, other["leadAgentId"], name="Foreign delivery")
    payload = _project_payload(project, routine=routine)
    response = (_create_with(client, payload, "assignedWorkflowId", foreign["id"])
                if entry == "create"
                else _patch_with(client, payload, "assignedWorkflowId", foreign["id"]))
    _assert_refused(response, 409, "team_workflow_project_mismatch")


@pytest.mark.parametrize("routine", [False, True])
def test_project_refuses_a_team_owned_workflow(scope_context, routine):
    _, client, _, project, _, lead, worker, _ = scope_context
    team = _team(client, lead, worker, name="Workflow owners")
    created = client.post("/api/v1/workflows", json={
        "name": "Team delivery", "ownerTeamId": team["id"], "workflowSteps": [_step(lead["id"])],
    })
    assert created.status_code == 201, created.text
    workflow = created.json()["workflow"]
    response = client.post("/api/v1/tasks", json={
        **_project_payload(project, routine=routine), "assignedWorkflowId": workflow["id"],
    })
    _assert_refused(response, 409, "team_workflow_project_mismatch")


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("entry", ["create", "patch", "assignment"])
def test_project_accepts_an_enabled_roster_agent(scope_context, routine, entry):
    _, client, _, project, _, _, worker, _ = scope_context
    payload = _project_payload(project, routine=routine)
    if entry == "create":
        response = _create_with(client, payload, "assignedAgentId", worker["id"])
    elif entry == "patch":
        response = _patch_with(client, payload, "assignedAgentId", worker["id"])
    else:
        response = _put_assignment(client, payload, "agentId", worker["id"])
    assert response.status_code in (200, 201), response.text
    assert response.json()["assignedAgentId"] == worker["id"]


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("entry", ["create", "patch"])
def test_project_accepts_its_own_workflow_without_a_team(scope_context, routine, entry):
    _, client, _, project, _, lead, _, _ = scope_context
    workflow = _workflow(client, project, lead["id"])
    payload = _project_payload(project, routine=routine)
    if entry == "create":
        response = _create_with(client, payload, "assignedWorkflowId", workflow["id"])
    else:
        response = _patch_with(client, payload, "assignedWorkflowId", workflow["id"])
    assert response.status_code in (200, 201), response.text
    assert response.json()["assignedWorkflowId"] == workflow["id"]
    assert not response.json().get("assignedTeamId")


def test_project_workflow_dispatches_in_the_project_workspace_without_a_team(scope_context):
    app, client, node, project, _, lead, _, _ = scope_context
    workflow = _workflow(client, project, lead["id"])
    task = client.post("/api/v1/tasks", json={
        "title": "Deliver", "projectId": project["id"], "assignedWorkflowId": workflow["id"],
        "status": "assigned",
    }).json()
    started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert started.status_code == 202, started.text
    assert started.json()["dispatch"]["state"] == "started", started.text
    session = started.json()["session"]
    assert session["projectId"] == project["id"]
    assert not session.get("teamId")
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert command["workspaceSubpath"] == project["workspaceSubpath"]
    assert command["logicalAgentId"] == lead["id"]


# --- Standalone scope --------------------------------------------------------


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("entry", ["create", "patch", "assignment"])
def test_standalone_accepts_a_project_member_agent(scope_context, routine, entry):
    _, client, node, _, _, _, worker, _ = scope_context
    payload = _standalone_payload(routine=routine, node=node)
    if entry == "create":
        response = _create_with(client, payload, "assignedAgentId", worker["id"])
    elif entry == "patch":
        response = _patch_with(client, payload, "assignedAgentId", worker["id"])
    else:
        response = _put_assignment(client, payload, "agentId", worker["id"])
    assert response.status_code in (200, 201), response.text
    assert response.json()["assignedAgentId"] == worker["id"]


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("entry", ["create", "patch", "assignment"])
def test_standalone_accepts_a_team_with_a_project_member(scope_context, routine, entry):
    _, client, node, _, _, lead, worker, _ = scope_context
    team = _team(client, lead, worker, name="Project crew")
    payload = _standalone_payload(routine=routine, node=node)
    if entry == "create":
        response = _create_with(client, payload, "assignedTeamId", team["id"])
    elif entry == "patch":
        response = _patch_with(client, payload, "assignedTeamId", team["id"])
    else:
        response = _put_assignment(client, payload, "teamId", team["id"])
    assert response.status_code in (200, 201), response.text
    assert response.json()["assignedTeamId"] == team["id"]


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("entry", ["create", "patch", "assignment"])
def test_standalone_refuses_a_legacy_project_workflow_team(scope_context, routine, entry):
    _, client, node, project, _, lead, worker, _ = scope_context
    workflow_team = client.post("/api/v1/teams", json={
        "name": "Legacy workflow", "leadAgentId": lead["id"],
        "memberAgentIds": [lead["id"], worker["id"]], "projectId": project["id"],
        "workflowSteps": [_step(lead["id"])],
    })
    assert workflow_team.status_code == 201, workflow_team.text
    team = workflow_team.json()["team"]
    payload = _standalone_payload(routine=routine, node=node)
    if entry == "create":
        response = _create_with(client, payload, "assignedTeamId", team["id"])
    elif entry == "patch":
        response = _patch_with(client, payload, "assignedTeamId", team["id"])
    else:
        response = _put_assignment(client, payload, "teamId", team["id"])
    _assert_refused(response, 409, "standalone_team_workflow")


@pytest.mark.parametrize("routine", [False, True])
@pytest.mark.parametrize("entry", ["create", "patch", "assignment"])
def test_standalone_accepts_an_independent_agent(scope_context, routine, entry):
    _, client, node, _, _, _, _, outsider = scope_context
    payload = _standalone_payload(routine=routine, node=node)
    if entry == "create":
        response = _create_with(client, payload, "assignedAgentId", outsider["id"])
    elif entry == "patch":
        response = _patch_with(client, payload, "assignedAgentId", outsider["id"])
    else:
        response = _put_assignment(client, payload, "agentId", outsider["id"])
    assert response.status_code in (200, 201), response.text
    assert response.json()["assignedAgentId"] == outsider["id"]


@pytest.mark.parametrize("routine", [False, True])
def test_standalone_accepts_an_independent_team(scope_context, routine):
    _, client, node, _, _, _, _, outsider = scope_context
    team = _team(client, outsider, name="Independents")
    payload = _standalone_payload(routine=routine, node=node)
    response = _create_with(client, payload, "assignedTeamId", team["id"])
    assert response.status_code == 201, response.text
    assert response.json()["assignedTeamId"] == team["id"]


def test_disabled_project_membership_does_not_exclude_standalone_assignment(scope_context):
    _, client, node, project, _, _, worker, _ = scope_context
    disabled = [
        {**member, "enabled": member["agentId"] != worker["id"]}
        for member in project["members"]
    ]
    updated = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": project["version"], "members": disabled,
    })
    assert updated.status_code == 200, updated.text
    response = client.post("/api/v1/tasks", json={
        **_standalone_payload(node=node), "assignedAgentId": worker["id"],
    })
    assert response.status_code in (200, 201), response.text
    assert response.json()["assignedAgentId"] == worker["id"]


def test_archived_project_members_remain_eligible_for_standalone_work(scope_context):
    _, client, node, project, _, _, worker, _ = scope_context
    archived = client.post(f"/api/v1/projects/{project['id']}/archive?expectedVersion={project['version']}")
    assert archived.status_code == 200, archived.text
    response = client.post("/api/v1/tasks", json={
        **_standalone_payload(node=node), "assignedAgentId": worker["id"],
    })
    assert response.status_code == 201, response.text


# --- Saved assignments are blocked before daemon work -----------------------


def _save_project_team_assignment(app, project, team_id):
    task = app.state.task_store.create_task({
        "title": "Saved legacy team", "ownerUserId": _owner(app),
        "projectId": project["id"], "status": "assigned",
    })
    return app.state.task_store.update_task(task["id"], {
        "assignedTeamId": team_id, "assignedAgentId": None, "assignedAgent": None,
    })


def _save_standalone_agent_assignment(app, node, agent):
    task = app.state.task_store.create_task({
        "title": "Saved standalone", "ownerUserId": _owner(app),
        "status": "assigned", "computerId": computer_id(node),
        "assignedAgentId": agent["id"], "assignedAgent": agent["executorKind"],
    })
    return task


def _owner(app):
    return app.state.auth_store.resolve_user_id("alice")


def _join_project(client, project, agent):
    current = client.get(f"/api/v1/projects/{project['id']}").json()["project"]
    members = [*current["members"], {
        "agentId": agent["id"], "role": "implementer",
        "responsibilities": "Deliver", "enabled": True,
    }]
    response = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": current["version"], "members": members,
    })
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("entry", ["manual", "scheduler", "automation"])
@pytest.mark.parametrize("target", ["team", "workflow_team"])
def test_saved_project_team_assignment_blocks_without_a_daemon_command(
    scope_context, entry, target
):
    app, client, node, project, _, lead, worker, _ = scope_context
    team = (_team(client, lead, worker, name="Crew") if target == "team" else None)
    if target == "workflow_team":
        created = client.post("/api/v1/teams", json={
            "name": "Legacy workflow", "leadAgentId": lead["id"],
            "memberAgentIds": [lead["id"], worker["id"]], "projectId": project["id"],
            "workflowSteps": [_step(lead["id"])],
        })
        assert created.status_code == 201, created.text
        team = created.json()["team"]
    _start_saved_project_assignment(app, client, project, team, entry, node)
    task = _project_team_tasks(app, project)[-1]
    assert task["status"] == "blocked", task.get("blockerReason")
    assert PROJECT_TEAM_FORBIDDEN in task["blockerReason"]
    assert task["dispatchOutcome"]["code"] == PROJECT_TEAM_FORBIDDEN
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


def _start_saved_project_assignment(app, client, project, team, entry, node):
    if entry == "automation":
        # The routine is legal when saved; the Team assignment lands later,
        # the way an older build would have left it.
        routine = client.post("/api/v1/tasks", json={
            "title": "Saved legacy automation", "projectId": project["id"],
            "isRoutine": True, "routineState": "active", "routineTriggers": DAILY_TRIGGERS,
        })
        assert routine.status_code == 201, routine.text
        app.state.task_store.update_task(routine.json()["id"], {"assignedTeamId": team["id"]})
        app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2))
        asyncio.run(app.state.task_scheduler.tick())
        return
    if entry == "scheduler":
        task = _save_project_team_assignment(app, project, team["id"])
        asyncio.run(app.state.task_scheduler.tick())
        return
    task = _save_project_team_assignment(app, project, team["id"])
    started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert started.status_code == 202, started.text
    assert started.json()["dispatch"]["state"] == "rejected", started.text


def _project_team_tasks(app, project):
    tasks = [
        task for task in app.state.task_store.list_tasks()
        if task.get("projectId") == project["id"]
        and task.get("assignedTeamId")
        and not task.get("isRoutine")
    ]
    assert tasks, "no saved team assignment"
    return tasks


@pytest.mark.parametrize("entry", ["manual", "scheduler", "automation"])
def test_saved_standalone_assignment_still_runs_after_its_agent_joins_a_project(
    scope_context, entry
):
    app, client, node, project, _, _, _, outsider = scope_context
    routine = None
    if entry == "automation":
        # Saved while the agent was still standalone, then the roster changed.
        created = client.post("/api/v1/tasks", json={
            "title": "Saved standalone automation", "computerId": computer_id(node),
            "isRoutine": True, "routineState": "active", "routineTriggers": DAILY_TRIGGERS,
            "assignedAgentId": outsider["id"],
        })
        assert created.status_code == 201, created.text
        routine = created.json()
    task = _save_standalone_agent_assignment(app, node, outsider)
    _join_project(client, project, outsider)
    if entry == "automation":
        app.state.task_scheduler.automations.tick(datetime.now(UTC) + timedelta(days=2))
        asyncio.run(app.state.task_scheduler.tick())
        task = _occurrence_of(app, routine["id"])
    elif entry == "scheduler":
        asyncio.run(app.state.task_scheduler.tick())
    else:
        started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert started.status_code == 202, started.text
        assert started.json()["dispatch"]["state"] == "started", started.text
    task = app.state.task_store.get_task(task["id"])
    assert task["status"] != "blocked", task.get("blockerReason")
    assert task["dispatchOutcome"]["state"] == "started", task.get("dispatchOutcome")
    commands = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    assert commands
    assert all(command["logicalAgentId"] == outsider["id"] for command in commands)


def _occurrence_of(app, routine_id):
    occurrences = [
        task for task in app.state.task_store.list_tasks()
        if task.get("sourceRoutineId") == routine_id
    ]
    assert len(occurrences) == 1, occurrences
    return occurrences[0]


def test_an_active_execution_is_never_reassigned_or_blocked(scope_context):
    app, client, node, project, _, _, _, outsider = scope_context
    task = _save_standalone_agent_assignment(app, node, outsider)
    started = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert started.status_code == 202, started.text
    assert started.json()["dispatch"]["state"] == "started", started.text
    owner = app.state.task_store.get_task(task["id"])["executionOwner"]
    [command] = app.state.registry.take_commands(node["id"], f"token_{node['id']}")
    _join_project(client, project, outsider)
    again = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert again.status_code == 202, again.text
    assert again.json()["task"]["status"] != "blocked"
    current = app.state.task_store.get_task(task["id"])
    assert current["executionOwner"] == owner
    assert current["status"] != "blocked"
    assert current["linkedSessionIds"]
    assert command["runId"]
    assert app.state.registry.take_commands(node["id"], f"token_{node['id']}") == []


# --- Escape hatches stay unchanged -----------------------------------------


def test_event_trigger_observation_filter_may_still_name_a_project_team(scope_context):
    _, client, node, project, _, lead, worker, outsider = scope_context
    team = _team(client, lead, worker, name="Observed crew")
    response = client.post("/api/v1/tasks", json={
        **_standalone_payload("Watch project work", node=node),
        "assignedAgentId": outsider["id"],
        "isRoutine": True, "routineState": "paused",
        "routineTriggers": [{"kind": "task_event", "on": "created", "filters": {
            "projectId": project["id"], "assignedTeamId": team["id"],
        }}],
    })
    assert response.status_code == 201, response.text
