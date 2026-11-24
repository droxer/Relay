"""Plan rounds draft ordered tasks; applying them creates tasks with prerequisites."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import test_project_setup_api as setup_api
from test_project_setup_api import _complete, _take_command

# Reuse the setup suite's project, computer, and agents.
setup_env = setup_api.setup_env


def _crewed(client, project, planner, builder, **brief) -> dict:
    latest = client.get(f"/api/v1/projects/{project['id']}").json()["project"]
    response = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": latest["version"],
        **brief,
        "leadAgentId": planner["id"],
        "members": [
            {"agentId": planner["id"], "role": "planner", "responsibilities": "Plan", "enabled": True},
            {"agentId": builder["id"], "role": "implementer", "responsibilities": "Build", "enabled": True},
        ],
    })
    assert response.status_code == 200, response.text
    return response.json()["project"]


def _plan(app, client, node, project, tasks, **body) -> dict:
    started = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Plan the pricing page", "mode": "plan", **body,
    })
    assert started.status_code == 202, started.text
    command = _take_command(app, node)
    _complete(app, node, command, started.json()["threadId"], proposal={
        "tasks": tasks, "rationale": "Design before build.", "members": [{"agentId": "x"}],
    })
    return command


def test_plan_mode_needs_a_crew(setup_env):
    _app, client, _node, project, _planner, _builder = setup_env
    client.patch(f"/api/v1/projects/{project['id']}", json={"expectedVersion": project["version"], "members": []})
    response = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Plan", "mode": "plan",
    })
    assert (response.status_code, response.json()["detail"]) == (409, "project_plan_needs_crew")


@pytest.mark.parametrize(("brief", "body", "expected"), [
    ({"goal": "Ship pricing", "description": "Use the existing design"}, {}, "Ship pricing\n\nUse the existing design"),
    ({"goal": "Ship pricing"}, {"intent": "   "}, "Ship pricing"),
    ({"description": "Use the existing design"}, {}, "Use the existing design"),
    ({"goal": "Ship pricing"}, {"intent": "Focus on copy"}, "Focus on copy"),
    ({"goal": "Ship pricing"}, {"intent": []}, None),
    ({"goal": "Ship pricing"}, {"revise": True}, None),
    ({}, {}, None),
])
def test_plan_intent_falls_back_to_the_project_brief(setup_env, brief, body, expected):
    app, client, node, project, planner, builder = setup_env
    project = _crewed(client, project, planner, builder, **brief)

    started = client.post(f"/api/v1/projects/{project['id']}/setup", json={"mode": "plan", **body})

    if expected is None:
        assert (started.status_code, started.json()["detail"]) == (400, "project_setup_intent_required")
        return
    assert started.status_code == 202, started.text
    assert started.json()["project"]["setup"]["intent"] == expected
    setup = _take_command(app, node)["state"]["project_setup"]
    assert setup["intent"] == expected
    assert setup.get("goal") == brief.get("goal")


def test_plan_round_sees_open_tasks_and_drafts_only_tasks(setup_env):
    app, client, node, project, planner, builder = setup_env
    project = _crewed(client, project, planner, builder)
    existing = client.post("/api/v1/tasks", json={"title": "Pick fonts", "projectId": project["id"]}).json()

    command = _plan(app, client, node, project, [
        {"key": "design", "title": "Design pricing", "after": [existing["id"]]},
        {"key": "build", "title": "Build pricing", "after": ["design", "later"]},
        {"key": "later", "title": "Announce"},
    ])

    setup_state = command["state"]["project_setup"]
    assert setup_state["mode"] == "plan"
    assert [task["id"] for task in setup_state["openTasks"]] == [existing["id"]]
    proposal = client.get(f"/api/v1/projects/{project['id']}/setup").json()["setup"]["proposal"]
    assert "members" not in proposal
    tasks = {task["key"]: task for task in proposal["tasks"]}
    assert tasks["design"]["afterTaskIds"] == [existing["id"]]
    assert tasks["build"]["after"] == ["design"], "a forward reference is dropped"


def test_applying_a_plan_creates_ordered_tasks_once(setup_env):
    app, client, node, project, planner, builder = setup_env
    project = _crewed(client, project, planner, builder)
    _plan(app, client, node, project, [
        {"key": "design", "title": "Design pricing"},
        {"key": "build", "title": "Build pricing", "after": ["design"], "assignedAgentId": builder["id"]},
        {"key": "skip", "title": "Skipped", "after": ["design"]},
    ])
    draft_id = client.get(f"/api/v1/projects/{project['id']}/setup").json()["setup"]["draftId"]
    body = {
        "draftId": draft_id, "taskKeys": ["design", "build"], "queue": True,
        "assignedAgentIds": {"design": None},
    }

    response = client.post(f"/api/v1/projects/{project['id']}/setup/tasks", json=body)

    assert response.status_code == 200, response.text
    design, build = response.json()["tasks"]
    assert design["status"] == build["status"] == "backlog"
    assert build["prerequisiteTaskIds"] == [design["id"]]
    assert build["waitingOn"] == [design["id"]]
    assert build["assignedAgentId"] == builder["id"]
    assert not design.get("assignedAgentId")
    assert response.json()["project"]["setup"]["state"] == "applied"
    drafting = app.state.task_store.get_task(response.json()["project"]["setup"]["taskId"])
    assert drafting["status"] == "done", "applying the plan closes its drafting task"
    queued = {task["id"] for task in app.state.task_store.list_dispatchable_tasks()}
    assert design["id"] not in queued and build["id"] not in queued

    again = client.post(f"/api/v1/projects/{project['id']}/setup/tasks", json=body)
    assert again.status_code == 200, again.text
    assert [task["id"] for task in again.json()["tasks"]] == [design["id"], build["id"]]
    titles = [t["title"] for t in client.get("/api/v1/tasks").json()["tasks"]]
    assert titles.count("Design pricing") == 1
    assert app.state.registry.daemon_store.active_run_request_for_task(design["id"]) is None
    blocked = client.post(f"/api/v1/tasks/{build['id']}/runs", json={})
    assert blocked.status_code == 409
    started = client.post(f"/api/v1/tasks/{design['id']}/runs", json={})
    assert started.status_code == 202, started.text
    assert started.json()["dispatch"]["state"] == "started"
    assert app.state.registry.daemon_store.active_run_request_for_task(design["id"]) is not None



def test_apply_refuses_a_stale_draft_or_unknown_keys(setup_env):
    app, client, node, project, planner, builder = setup_env
    project = _crewed(client, project, planner, builder)
    _plan(app, client, node, project, [{"key": "design", "title": "Design pricing"}])
    draft_id = client.get(f"/api/v1/projects/{project['id']}/setup").json()["setup"]["draftId"]
    url = f"/api/v1/projects/{project['id']}/setup/tasks"

    stale = client.post(url, json={"draftId": "setup_other"})
    unknown = client.post(url, json={"draftId": draft_id, "taskKeys": ["nope"]})

    assert (stale.status_code, stale.json()["detail"]) == (409, "project_setup_draft_mismatch")
    assert (unknown.status_code, unknown.json()["detail"]) == (400, "project_setup_task_keys_invalid")


def test_a_retried_apply_keeps_tasks_in_backlog(setup_env):
    app, client, node, project, planner, builder = setup_env
    project = _crewed(client, project, planner, builder)
    _plan(app, client, node, project, [{"key": "design", "title": "Design pricing"}])
    draft_id = client.get(f"/api/v1/projects/{project['id']}/setup").json()["setup"]["draftId"]
    url = f"/api/v1/projects/{project['id']}/setup/tasks"

    first = client.post(url, json={"draftId": draft_id})
    queued = client.post(url, json={"draftId": draft_id, "queue": True})

    assert first.json()["tasks"][0]["status"] == "backlog"
    assert queued.json()["tasks"][0]["id"] == first.json()["tasks"][0]["id"]
    assert queued.json()["tasks"][0]["status"] == "backlog"


def test_applying_an_empty_plan_selection_resolves_the_draft_without_tasks(setup_env):
    app, client, node, project, planner, builder = setup_env
    project = _crewed(client, project, planner, builder)
    _plan(app, client, node, project, [{"key": "design", "title": "Design pricing"}])
    url = f"/api/v1/projects/{project['id']}/setup"
    draft_id = client.get(url).json()["setup"]["draftId"]

    response = client.post(f"{url}/tasks", json={"draftId": draft_id, "taskKeys": []})

    assert response.status_code == 200, response.text
    assert response.json()["tasks"] == []
    assert response.json()["project"]["setup"]["state"] == "applied"


@pytest.mark.parametrize("mode", ["setup", "plan"])
def test_interrupted_apply_rolls_back_tasks_before_retry(setup_env, monkeypatch, mode):
    app, client, node, project, planner, builder = setup_env
    project = _crewed(client, project, planner, builder)
    project_url = f"/api/v1/projects/{project['id']}"
    started = client.post(f"{project_url}/setup", json={"mode": mode, "intent": "Plan the pricing page"})
    assert started.status_code == 202, started.text
    _complete(app, node, _take_command(app, node), started.json()["threadId"], proposal={
        "goal": "Ship pricing",
        "tasks": [{"key": "design", "title": "Design pricing"}],
    })
    project = client.get(project_url).json()["project"]
    if mode == "setup":
        brief = client.patch(project_url, json={"expectedVersion": project["version"], "goal": "Ship pricing"})
        assert brief.status_code == 200, brief.text
        project = brief.json()["project"]
    assert project["setup"]["state"] == "proposed"
    task_id = project["setup"]["taskId"]
    initial_status = app.state.task_store.get_task(task_id)["status"]
    url = f"{project_url}/setup/tasks"
    body = {"draftId": project["setup"]["draftId"], "queue": True}
    store = app.state.project_store

    with monkeypatch.context() as interrupted:
        def fail_recording(*_args):
            raise HTTPException(503, "simulated project write failure")

        interrupted.setattr(store, "_replace_members", fail_recording)
        failed = client.post(url, json=body)
    assert failed.status_code == 503
    assert [task["id"] for task in client.get("/api/v1/tasks").json()["tasks"]] == [task_id]
    assert app.state.task_store.get_task(task_id)["status"] == initial_status
    assert store.get_project(project["id"])["setup"]["state"] == "proposed"

    retry = client.post(url, json=body)
    assert retry.status_code == 200, retry.text
    assert len(client.get("/api/v1/tasks").json()["tasks"]) == 2
    assert retry.json()["tasks"][0]["status"] == "backlog"
    assert retry.json()["project"]["setup"]["state"] == "applied"
    assert app.state.task_store.get_task(task_id)["status"] == "done"
    again = client.post(url, json=body)
    assert again.json()["tasks"] == retry.json()["tasks"]
    assert again.json()["project"]["version"] == retry.json()["project"]["version"]


def test_plan_apply_refuses_more_than_ten_prerequisites(setup_env):
    app, client, node, project, planner, builder = setup_env
    project = _crewed(client, project, planner, builder)
    existing = [client.post("/api/v1/tasks", json={
        "title": f"Existing {index}", "projectId": project["id"],
    }).json()["id"] for index in range(11)]
    _plan(app, client, node, project, [
        {"key": "build", "title": "Build pricing", "after": existing},
    ])
    draft_id = client.get(f"/api/v1/projects/{project['id']}/setup").json()["setup"]["draftId"]

    response = client.post(f"/api/v1/projects/{project['id']}/setup/tasks", json={"draftId": draft_id})

    assert response.status_code == 400, response.text
    assert response.json()["detail"] == {"code": "task_prerequisites_too_many", "key": "build"}
    assert len(client.get("/api/v1/tasks").json()["tasks"]) == len(existing) + 1
    assert app.state.project_store.get_project(project["id"])["setup"]["state"] == "proposed"


def test_concurrent_plan_applies_return_the_same_tasks(setup_env):
    app, client, node, project, planner, builder = setup_env
    project = _crewed(client, project, planner, builder)
    _plan(app, client, node, project, [
        {"key": "design", "title": "Design pricing"},
        {"key": "build", "title": "Build pricing", "after": ["design"]},
    ])
    draft_id = client.get(f"/api/v1/projects/{project['id']}/setup").json()["setup"]["draftId"]
    start = Barrier(2)

    def apply():
        caller = TestClient(app, cookies=client.cookies)
        start.wait(timeout=10)
        return caller.post(f"/api/v1/projects/{project['id']}/setup/tasks", json={
            "draftId": draft_id, "queue": True,
        })

    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = [pool.submit(apply) for _ in range(2)]
        responses = [future.result(timeout=20) for future in pending]

    for response in responses:
        assert response.status_code == 200, response.text
    first, second = [[task["id"] for task in response.json()["tasks"]] for response in responses]
    assert first == second
    assert len(client.get("/api/v1/tasks").json()["tasks"]) == 3
    assert responses[1].json()["tasks"][1]["waitingOn"] == [first[0]]


@pytest.mark.parametrize("mode", [{}, [], 1, True, "unknown"])
def test_setup_refuses_invalid_mode_types(setup_env, mode):
    _app, client, _node, project, _planner, _builder = setup_env
    response = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Plan", "mode": mode,
    })
    assert (response.status_code, response.json()["detail"]) == (400, "project_setup_mode_invalid")
