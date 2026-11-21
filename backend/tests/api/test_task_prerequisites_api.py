"""Task prerequisites over HTTP, and the dispatch queue that honours them."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, update

from relay.app import create_app
from relay.persistence.events import relay_event, relay_task_event
from test_project_routes import _agent, _bootstrap, _login_alice, _register_computer
from user_ids import user_id


@pytest.fixture
def project_context(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register_computer(app, "node_alice_prereq", "prereq-computer")
    lead = _agent(client, app, node, "Lead", "codex")
    _login_alice(client)
    created = client.post("/api/v1/projects", json={
        "name": "Ordered work", "daemonNodeId": node["id"], "leadAgentId": lead["id"],
        "members": [dict(agentId=lead["id"], role="implementer", responsibilities="Deliver", enabled=True)],
    })
    assert created.status_code == 201, created.text
    return app, client, created.json()["project"]


def _task(client, project, title: str) -> dict:
    response = client.post("/api/v1/tasks", json={"title": title, "projectId": project["id"]})
    assert response.status_code == 201, response.text
    return response.json()


def _set(client, task, ids):
    return client.put(f"/api/v1/tasks/{task['id']}/prerequisites", json={"prerequisiteTaskIds": ids})


def test_thread_task_view_keeps_origin_wait_and_adopted_steps(project_context, monkeypatch):
    app, client, project = project_context
    owner = project["ownerUserId"]
    sessions = app.state.session_store
    store = app.state.task_store
    thread = sessions.create_session({
        "ownerUserId": owner, "projectId": project["id"], "workspacePath": "",
        "taskGoal": "Check the scoped Task list", "participants": ["human", "codex"],
    })
    session_id = thread["id"]
    parent = store.create_task({"ownerUserId": owner, "title": "Weekly automation", "isRoutine": True})
    origin = store.create_task({
        "ownerUserId": owner, "projectId": project["id"], "title": "Related work",
        "sourceRoutineId": parent["id"], "description": "Verbose work context. " * 2000,
        "permissionMode": "yolo",
    })
    store.link_session(origin["id"], session_id)
    waiting = store.create_task({"ownerUserId": owner, "title": "Wait for the reader"})
    store.append_event(waiting["id"], relay_task_event("task.status", waiting["id"], {
        "status": "waiting_for_human", "sessionId": session_id,
        "request": {"kind": "question", "inputQuestion": "Which one?", "questionId": "q1"},
    }))
    suggestion = "Do the suggested follow-up"
    earlier = store.create_task({"ownerUserId": owner, "projectId": project["id"], "title": suggestion})
    adopted = store.create_task({"ownerUserId": owner, "projectId": project["id"], "title": suggestion})
    newest = max((earlier, adopted), key=lambda task: (task["updatedAt"], task["id"]))
    store.create_task({"ownerUserId": owner, "title": suggestion})
    store.create_task({"ownerUserId": owner, "projectId": project["id"], "title": "Unrelated project work"})
    active = store.create_task({"ownerUserId": owner, "title": "Current round's legacy Task"})
    sessions.append_event(session_id, relay_event("collaboration.round.started", session_id, {
        "manifest": {"roundId": "round-1", "workScope": {"kind": "task", "taskId": active["id"]}},
    }))
    sessions.append_event(session_id, relay_event("session.completed", session_id, {
        "outcome": "Completed the review.", "nextSteps": [suggestion],
    }))

    def reject_replay(*_args, **_kwargs):
        pytest.fail("The thread task projection must use snapshots")

    monkeypatch.setattr(store, "get_task", reject_replay)
    monkeypatch.setattr(sessions, "get_session", reject_replay)
    params = {"view": "summary", "threadId": session_id}
    response = client.get("/api/v1/tasks", params=params)
    assert response.status_code == 200
    payload = response.json()
    rows = {item["id"]: item for item in payload["tasks"]}
    assert set(rows) == {origin["id"], waiting["id"], parent["id"], newest["id"], active["id"]}
    assert rows[origin["id"]]["linkedSessionIds"] == [session_id]
    assert rows[origin["id"]]["permissionMode"] == "yolo"
    assert rows[waiting["id"]]["awaiting"]["questionId"] == "q1"
    assert payload["threadTaskContext"]["nextSteps"] == [suggestion]
    assert payload["threadTaskContext"]["activeTaskId"] == active["id"]
    assert len(response.content) < 3_000
    assert client.get("/api/v1/tasks", params=params, headers={
        "If-None-Match": response.headers["ETag"],
    }).status_code == 304
    with store.engine.begin() as conn:
        conn.execute(delete(store.task_sessions).where(store.task_sessions.c.task_id == origin["id"]))
    assert client.get("/api/v1/tasks", params=params).json() == payload
    other = TestClient(app)
    assert other.post("/api/v1/auth/login", json={
        "username": "admin", "password": "kestrel-vault-7719",
    }).status_code == 200
    assert other.get("/api/v1/tasks", params=params).status_code == 403


def test_issue_window_filters_the_collection_and_pages_table_and_lanes(project_context):
    app, client, project = project_context
    owner = project["ownerUserId"]
    store = app.state.task_store
    store.create_task({"ownerUserId": owner, "title": "Other priority", "priority": "high"})
    for index in range(55):
        store.create_task({
            "ownerUserId": owner, "projectId": project["id"], "title": f"Work {index:03}",
            "description": "À tester" if index == 0 else "detail " * 100, "tags": ["Café"],
        })
    done = store.create_task({"ownerUserId": owner, "title": "Finished"})
    store.append_event(done["id"], relay_task_event("task.status", done["id"], {"status": "done"}))
    store.create_task({"ownerUserId": owner, "title": "Automation", "isRoutine": True})
    other = TestClient(app)
    assert other.post("/api/v1/auth/login", json={
        "username": "admin", "password": "kestrel-vault-7719",
    }).status_code == 200
    admin = other.get("/api/v1/auth/me").json()["user"]
    store.create_task({"ownerUserId": admin["userId"], "title": "Private task"})

    params = {"view": "summary", "scope": "issues", "layout": "list", "sort": "title"}
    response = client.get("/api/v1/tasks", params=params)
    assert response.status_code == 200
    first = response.json()
    assert len(first["tasks"]) == 50
    assert first["page"] == {"page": 1, "total": 56}
    assert first["issueCount"] == 57
    assert first["counts"]["open"] == 56
    assert first["counts"]["untriaged"] == 1
    assert first["counts"]["done"] == 1
    assert first["groupTotals"] == {"none": 1, project["id"]: 55}
    assert first["tags"] == ["Café"]
    assert all(task["description"] == "" for task in first["tasks"])
    assert client.get("/api/v1/tasks", params=params, headers={
        "If-None-Match": response.headers["ETag"],
    }).status_code == 304

    last = client.get("/api/v1/tasks", params={**params, "page": 999}).json()
    assert last["page"] == {"page": 2, "total": 56}
    assert [task["title"] for task in last["tasks"]] == [f"Work {index:03}" for index in range(49, 55)]
    match = client.get("/api/v1/tasks", params={
        **params, "sort": "-title", "tag": "CAFÉ", "q": "À TESTER", "page": 2,
    }).json()
    assert [task["title"] for task in match["tasks"]] == ["Work 000"]
    assert match["page"] == {"page": 1, "total": 1}
    board = client.get("/api/v1/tasks", params={
        **params, "layout": "board", "lanes": "backlog:6",
    }).json()
    assert board["lanes"]["backlog"] == {"page": 6, "total": 56}
    assert board["lanes"]["done"] == {"page": 1, "total": 0}
    assert [task["id"] for task in board["tasks"]] == [task["id"] for task in last["tasks"]]
    assert other.get("/api/v1/tasks", params=params).json()["issueCount"] == 1
    prerequisites = {"view": "prerequisite-choices", "projectId": project["id"]}
    choices = client.get("/api/v1/tasks", params=prerequisites).json()["tasks"]
    assert len(choices) == 55
    assert set(choices[0]) == {"id", "title", "number"}
    assert other.get("/api/v1/tasks", params=prerequisites).status_code in (403, 404)

    held = match["tasks"][0]
    store.append_event(held["id"], relay_task_event("task.status", held["id"], {"status": "blocked"}))
    held_board = client.get("/api/v1/tasks", params={**params, "layout": "board", "queue": "blocked"}).json()
    assert held_board["lanes"]["backlog"]["total"] == 1
    assert [task["id"] for task in held_board["tasks"]] == [held["id"]]
    app.state.project_store.archive_project(project["id"], expected_version=project["version"])
    assert client.get("/api/v1/tasks", params=params).json()["issueCount"] == 2
    archived = client.get("/api/v1/tasks", params={**params, "projectId": project["id"]}).json()
    assert archived["issueCount"] == 57
    assert archived["page"]["total"] == 55


def test_project_scope_filters_summaries_before_limit(project_context):
    _app, client, project = project_context
    first, second = _task(client, project, "Design"), _task(client, project, "Build")
    assert _set(client, second, [first["id"]]).status_code == 200
    intake = client.post("/api/v1/tasks", json={"title": "Unrelated work"}).json()

    global_path = "/api/v1/tasks?view=summary&limit=1"
    scoped_path = f"{global_path}&projectId={project['id']}"
    response = client.get(scoped_path)
    [listed] = response.json()["tasks"]
    assert listed["id"] == second["id"]
    assert [row["id"] for row in listed["waitingOnSummaries"]] == [first["id"]]
    assert client.get(global_path).json()["tasks"][0]["id"] == intake["id"]
    assert client.get(scoped_path, headers={"If-None-Match": response.headers["etag"]}).status_code == 304
    assert client.get(f"{global_path}&projectId=invalid").json()["tasks"] == []


def test_home_projects_count_all_issues_but_load_only_inbox_candidates(project_context):
    app, client, project = project_context
    store = app.state.task_store
    dormant = _task(client, project, "Quiet issue")
    deadline = _task(client, project, "Due soon")
    store.update_task(deadline["id"], {"dueDate": "2099-01-02", "description": "Details that Home does not render"})
    blocked = _task(client, project, "Has a prerequisite")
    assert _set(client, blocked, [dormant["id"]]).status_code == 200
    finished = [_task(client, project, f"Finished {i}") for i in range(7)]
    for task in finished:
        store.update_task(task["id"], {"status": "done"})

    response = client.get("/api/v1/tasks?view=summary&scope=home")
    assert response.status_code == 200, response.text
    data = response.json()
    rows = {task["id"]: task for task in data["tasks"]}
    assert set(rows) == {deadline["id"], blocked["id"], *(task["id"] for task in finished[-5:])}
    assert rows[deadline["id"]]["description"] == ""
    assert rows[blocked["id"]]["waitingOnSummaries"][0]["id"] == dormant["id"]
    counts = data["homeProjects"][project["id"]]
    assert counts["total"] == 10
    assert counts["progress"] == {"done": 7, "review": 0, "running": 0, "blocked": 0}
    assert counts["updatedAt"]
    assert {task["id"] for task in client.get("/api/v1/tasks?view=summary").json()["tasks"]} >= {dormant["id"], finished[0]["id"]}


def test_home_summarizes_untriaged_work_and_keeps_due_intake_rows(project_context):
    app, client, _project = project_context
    store = app.state.task_store
    owner = client.get("/api/v1/auth/me").json()["user"]["userId"]
    quiet = store.create_task({"title": "Untriaged", "ownerUserId": owner})
    due = store.create_task({"title": "Untriaged with deadline", "ownerUserId": owner, "dueDate": "2099-01-02"})
    cancelled = store.create_task({"title": "Cancelled", "ownerUserId": owner})
    store.update_task(cancelled["id"], {"status": "cancelled"})
    store.create_task({"title": "Other account", "ownerUserId": user_id("bob")})

    data = client.get("/api/v1/tasks?view=summary&scope=home").json()
    assert [task["id"] for task in data["tasks"]] == [due["id"]]
    assert data["homeUntriaged"] == {
        "count": 2,
        "firstCreatedAt": quiet["createdAt"],
        "lastCreatedAt": due["createdAt"],
    }


def test_home_checks_prerequisite_projects_in_one_compact_read(project_context):
    app, client, project = project_context
    projects = app.state.project_store
    tasks = app.state.task_store
    owner = project["ownerUserId"]
    dependencies = {}
    for index in range(8):
        item = projects.create_project(owner, {
            "name": f"Project {index}", "computerId": project["computerId"], "members": [],
            "context": "Long context " * 10_000,
        })
        scope = {"ownerUserId": owner, "projectId": item["id"]}
        upstream = tasks.create_task({**scope, "title": "Design"})
        downstream = tasks.create_task({**scope, "title": "Build"})
        tasks.set_task_prerequisites(downstream["id"], [upstream["id"]])
        dependencies[downstream["id"]] = upstream["id"]

    project_reads = []

    def record_read(_conn, _cursor, statement, *_args):
        if statement.startswith("SELECT projects."):
            project_reads.append(statement)

    event.listen(projects.engine, "before_cursor_execute", record_read)
    try:
        response = client.get("/api/v1/tasks?view=summary&scope=home")
    finally:
        event.remove(projects.engine, "before_cursor_execute", record_read)

    assert response.status_code == 200
    rows = response.json()["tasks"]
    assert {row["id"]: row["waitingOnSummaries"][0]["id"] for row in rows} == dependencies
    assert len(project_reads) == 1
    assert "projects.snapshot" not in project_reads[0]


def test_computer_board_scope_keeps_bound_and_unplaced_candidates(project_context):
    app, client, project = project_context
    owner = project["ownerUserId"]
    store = app.state.task_store
    chosen = "device:alice:first"
    other = "device:alice:second"
    local = store.create_task({"ownerUserId": owner, "title": "Local work", "computerId": chosen})
    unplaced = store.create_task({"ownerUserId": owner, "title": "Legacy unplaced work"})
    moved = store.create_task({"ownerUserId": owner, "title": "Recorded workspace", "computerId": other})
    store.append_event(moved["id"], relay_task_event("task.workspace_bound", moved["id"], {
        "binding": {"computerId": chosen, "layout": "task", "subpath": f"tasks/{moved['id']}"},
    }))
    remote_task = store.create_task({"ownerUserId": owner, "title": "Other Computer", "computerId": other})
    store.create_task({"ownerUserId": owner, "title": "Project work", "projectId": project["id"]})
    store.create_task({"ownerUserId": owner, "title": "Automation definition", "computerId": chosen, "isRoutine": True})
    params = {"view": "summary", "scope": "board", "computerId": chosen}
    result = client.get("/api/v1/tasks", params=params)
    assert result.status_code == 200
    assert {task["id"] for task in result.json()["tasks"]} == {local["id"], unplaced["id"], moved["id"]}
    first = client.get("/api/v1/tasks", params={**params, "limit": 1}).json()["tasks"]
    assert len(first) == 1 and first[0]["id"] in {local["id"], unplaced["id"], moved["id"]}
    other_computer = client.get("/api/v1/tasks", params={**params, "computerId": other}).json()["tasks"]
    assert {task["id"] for task in other_computer} == {unplaced["id"], remote_task["id"]}


def test_project_task_board_pages_after_search_and_counts_workflow_stages(project_context):
    app, client, project = project_context
    store = app.state.task_store
    scope = {"ownerUserId": project["ownerUserId"], "projectId": project["id"]}
    tasks = [store.create_task({**scope, "title": f"Issue {i:02}", "description": "Long text " * 2000}) for i in range(29)]
    target = tasks[-1]
    store.update_task(target["id"], {"description": "Searchable phrase beyond the first page"})
    finished = store.create_task({**scope, "title": "Finished", "status": "done"})
    held = store.create_task({**scope, "title": "Held", "status": "running"})
    store.update_task(held["id"], {"status": "blocked"})
    occurrence = store.create_task({**scope, "title": "Ignored run", "sourceRoutineId": target["id"]})
    store.create_task({"ownerUserId": scope["ownerUserId"], "title": "Outside this project"})
    params = {"view": "summary", "scope": "board", "layout": "list", "projectId": project["id"], "sort": "title"}

    response = client.get("/api/v1/tasks", params=params)
    assert response.status_code == 200, response.text
    first = response.json()
    assert first["page"] == {"page": 1, "total": 31}
    assert first["issueCount"] == 31
    assert first["sectionCounts"]["backlog"] == 29
    assert first["sectionCounts"]["done"] == first["sectionCounts"]["running"] == 1
    assert len(first["tasks"]) == 25 and all(not row["description"] for row in first["tasks"])
    assert len(response.content) < 25_000
    assert target["id"] not in {row["id"] for row in first["tasks"]}

    search = client.get("/api/v1/tasks", params={**params, "q": "phrase beyond", "page": 2}).json()
    assert search["page"] == {"page": 1, "total": 1}
    assert [row["id"] for row in search["tasks"]] == [target["id"]]
    blocked = client.get("/api/v1/tasks", params={**params, "status": "blocked"}).json()
    assert [row["id"] for row in blocked["tasks"]] == [held["id"]]
    assert blocked["sectionCounts"] == first["sectionCounts"]
    board = client.get("/api/v1/tasks", params={**params, "layout": "board", "lanes": "backlog:3", "status": "blocked"}).json()
    assert board["lanes"]["backlog"] == {"page": 3, "total": 29}
    assert [row["id"] for row in board["tasks"]] == [*(task["id"] for task in tasks[20:]), held["id"], finished["id"]]
    record = client.get(f"/api/v1/tasks/{target['id']}", params={"view": "record"}).json()
    assert record["description"] == "Searchable phrase beyond the first page"
    assert _set(client, target, [tasks[0]["id"]]).status_code == 200
    assert _set(client, tasks[1], [target["id"]]).status_code == 200
    links = client.get(f"/api/v1/tasks/{target['id']}", params={"view": "record"}).json()["prerequisiteSummaries"]
    assert {row["title"] for row in links} == {tasks[0]["title"], tasks[1]["title"]}
    expected = {row["id"] for row in [*tasks[2:-1], finished, held, occurrence]}
    choice_params = {"view": "prerequisite-choices", "projectId": project["id"], "taskId": target["id"]}
    first_choices = client.get("/api/v1/tasks", params=choice_params).json()
    assert len(first_choices["tasks"]) == 25
    assert first_choices["page"] == {"page": 1, "total": len(expected)}
    more_choices = client.get("/api/v1/tasks", params={**choice_params, "page": 2}).json()
    assert {row["id"] for row in first_choices["tasks"] + more_choices["tasks"]} == expected
    search_choices = client.get("/api/v1/tasks", params={**choice_params, "q": f"#{tasks[2]['number']}"}).json()
    assert tasks[2]["id"] in {row["id"] for row in search_choices["tasks"]}


def test_computer_task_board_pages_legacy_placement_and_resolves_latest_owned_thread(project_context):
    app, client, project = project_context
    owner = project["ownerUserId"]
    store = app.state.task_store
    sessions = app.state.session_store
    node = _register_computer(app, "node_alice_board_paging", "board-paging-machine")
    chosen = f"device:{owner}:board-paging-machine"
    other = f"device:{owner}:other-machine"

    def linked_thread(task, thread_owner=owner, **identity):
        thread = sessions.create_session({
            "ownerUserId": thread_owner, "workspacePath": "", "taskGoal": "Recorded work",
            "participants": ["human", "codex"], **identity,
        })
        store.link_session(task["id"], thread["id"])

    scoped = [store.create_task({"ownerUserId": owner, "title": f"Board item {i:02}", "computerId": chosen}) for i in range(26)]
    unplaced = [store.create_task({"ownerUserId": owner, "title": f"Old work {i:02}"}) for i in range(11)]
    inferred = store.create_task({"ownerUserId": owner, "title": "Inferred this Computer"})
    linked_thread(inferred, computerId=other)
    linked_thread(inferred, daemonNodeId=node["id"])
    linked_thread(inferred, thread_owner=user_id("bob"), computerId=other)
    elsewhere = store.create_task({"ownerUserId": owner, "title": "Inferred another Computer"})
    linked_thread(elsewhere, computerId=other)
    moved = store.create_task({"ownerUserId": owner, "title": "Workspace binding", "computerId": other})
    store.append_event(moved["id"], relay_task_event("task.workspace_bound", moved["id"], {
        "binding": {"computerId": chosen, "layout": "task", "subpath": f"tasks/{moved['id']}"},
    }))
    store.create_task({"ownerUserId": user_id("bob"), "title": "Another owner's work", "computerId": chosen})
    params = {"view": "summary", "scope": "board", "layout": "list", "computerId": chosen, "sort": "title"}
    response = client.get("/api/v1/tasks", params=params)
    assert response.status_code == 200, response.text
    first = response.json()
    assert first["page"] == {"page": 1, "total": 28}
    assert [row["id"] for row in first["tasks"]] == [task["id"] for task in scoped[:25]]
    second = client.get("/api/v1/tasks", params={**params, "page": 2, "unplacedPage": 2}).json()
    assert [row["id"] for row in second["tasks"]] == [scoped[-1]["id"], inferred["id"], moved["id"]]
    assert first["unplaced"]["total"] == second["unplaced"]["total"] == 12
    assert len(first["unplaced"]["tasks"]) == 10 and len(second["unplaced"]["tasks"]) == 2
    assert {row["id"] for row in first["unplaced"]["tasks"] + second["unplaced"]["tasks"]} == {
        inferred["id"], *(task["id"] for task in unplaced),
    }
    record = client.get(f"/api/v1/tasks/{inferred['id']}", params={"view": "record"}).json()
    assert record["linkedComputerId"] == chosen


def test_project_dashboard_counts_all_issues_and_only_hydrates_five_attention_rows(project_context):
    app, client, project = project_context
    store = app.state.task_store
    scope = {"ownerUserId": project["ownerUserId"], "projectId": project["id"]}
    for i in range(9):
        store.create_task({**scope, "title": f"Old item {i}", "dueDate": f"2026-11-{i + 1:02}"})
    hold = store.create_task({**scope, "title": "Held", "status": "blocked", "description": "Large text. " * 2000})
    store.create_task({**scope, "title": "In progress", "status": "running"})
    store.create_task({**scope, "title": "Finished", "status": "done", "dueDate": "2026-11-01"})
    store.create_task({**scope, "title": "Ignored Automation", "isRoutine": True})
    store.create_task({**scope, "title": "Ignored run", "sourceRoutineId": hold["id"]})
    result = client.get("/api/v1/tasks", params={
        "view": "summary", "scope": "project-dashboard", "projectId": project["id"], "today": "2026-11-12",
    })
    assert result.status_code == 200
    data = result.json()
    assert data["tasks"] == []
    assert data["flowPolicy"]["wipLimit"] == 5
    dashboard = data["projectDashboard"]
    assert dashboard["metrics"] == {"total": 12, "active": 1, "blocked": 1, "overdue": 9, "done": 1}
    assert dashboard["attentionTotal"] == 10
    assert [entry["task"]["title"] for entry in dashboard["attention"]] == ["Held", "Old item 0", "Old item 1", "Old item 2", "Old item 3"]
    assert "description" not in dashboard["attention"][0]["task"]
    assert len(result.content) < 2_000


def test_task_list_scopes_keep_matching_rows_before_limit(project_context):
    app, client, project = project_context
    store = app.state.task_store
    owner = project["ownerUserId"]
    ordinary = _task(client, project, "Tracked work")
    shared = {"ownerUserId": owner, "projectId": project["id"]}
    routine = store.create_task({"title": "Daily update", "isRoutine": True, **shared})
    occurrence = store.create_task({"title": "Daily run", "sourceRoutineId": routine["id"], **shared})
    store.update_task(occurrence["id"], {"status": "review"})
    old_run = store.create_task({"title": "Old run", "sourceRoutineId": routine["id"], **shared})
    store.update_task(old_run["id"], {"status": "done"})
    outside = store.create_task({"title": "Another automation", "isRoutine": True, "ownerUserId": owner})
    store.create_task({"title": "Other user", "isRoutine": True, "ownerUserId": user_id("bob")})

    def listed(**params):
        response = client.get("/api/v1/tasks", params={"view": "summary", **params})
        assert response.status_code == 200, response.text
        return {task["id"] for task in response.json()["tasks"]}

    assert listed(scope="board", projectId=project["id"], limit=1) == {ordinary["id"]}
    assert listed(scope="automations", projectId=project["id"]) == {routine["id"], occurrence["id"]}
    assert listed(scope="automations", limit=1) == {outside["id"]}
    assert listed(scope="issues") == {ordinary["id"], occurrence["id"], old_run["id"]}
    assert listed() == {ordinary["id"], routine["id"], occurrence["id"], old_run["id"], outside["id"]}


def test_automation_page_filters_before_paging_and_carries_run_context(project_context):
    app, client, project = project_context
    store = app.state.task_store
    owner = project["ownerUserId"]
    scope = {"ownerUserId": owner, "projectId": project["id"], "isRoutine": True}
    defaults = [store.create_task({**scope, "title": f"Job {i:02}", "description": "Large body " * 300}) for i in range(28)]
    store.update_task(defaults[-1]["id"], {"description": "Find this automation by instructions"})
    schedule = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "09:00"}}}]
    active = {**scope, "routineState": "active"}
    due = store.create_task({**active, "title": "Due", "routineTriggers": schedule, "routineNextRunAt": "2000-01-01T09:00:00Z"})
    future = store.create_task({**active, "title": "Future", "routineTriggers": schedule, "routineNextRunAt": "2099-01-01T09:00:00Z"})
    listening = store.create_task({**active, "title": "Listening", "routineTriggers": [{"kind": "webhook"}]})
    store.create_task({**active, "title": "On demand"})
    running = store.create_task({**scope, "title": "Paused while running"})
    run = store.create_task({
        "ownerUserId": owner, "projectId": project["id"], "title": "Live occurrence", "status": "running", "sourceRoutineId": running["id"],
    })
    store.create_task({"ownerUserId": owner, "title": "Another workspace", "isRoutine": True})
    store.create_task({"ownerUserId": user_id("bob"), "title": "Other account", "isRoutine": True})
    params = {"view": "summary", "scope": "automations", "layout": "list", "projectId": project["id"], "sort": "title"}
    response = client.get("/api/v1/tasks", params=params)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["automationCount"] == 33
    assert data["page"] == {"page": 1, "total": 33}
    assert data["counts"] == {"paused": 28, "running": 1, "due": 1, "scheduled": 1, "listening": 1, "on_demand": 1}
    assert data["hasLiveRuns"] is True
    assert len(data["tasks"]) == 25 and len(response.content) < 18_000
    assert all(row["description"] == "" and row["linkedSessionIds"] == [] for row in data["tasks"])
    assert run["id"] not in {row["id"] for row in data["tasks"]}
    assert defaults[-1]["id"] not in {row["id"] for row in data["tasks"]}
    found = client.get("/api/v1/tasks", params={**params, "q": "by instructions", "page": 2}).json()
    assert [row["id"] for row in found["tasks"]] == [defaults[-1]["id"]]
    assert found["page"] == {"page": 1, "total": 1}
    scheduled = client.get("/api/v1/tasks", params={**params, "trigger": "schedule", "sort": "-nextRun"}).json()
    assert [row["id"] for row in scheduled["tasks"]] == [future["id"], due["id"]]
    selected = client.get("/api/v1/tasks", params={**params, "state": "listening"}).json()
    assert selected["counts"] == data["counts"]
    assert selected["states"] == {listening["id"]: "listening"}
    record = client.get(f"/api/v1/tasks/{run['id']}", params={"view": "record"}).json()
    assert record["routineParent"] == {"id": running["id"], "title": running["title"]}
    store.append_event(running["id"], relay_task_event("task.occurrence_created", running["id"], {"occurrenceId": run["id"]}))
    path = f"/api/v1/tasks/{running['id']}"
    assert client.get(path).json()["occurrenceIds"] == [run["id"]]
    detail = client.get(f"{path}?view=record")
    assert detail.json()["hasRunningOccurrence"] is True
    assert "occurrenceIds" not in detail.json()
    headers = {"If-None-Match": detail.headers["etag"]}
    assert client.get(f"{path}?view=record", headers=headers).status_code == 304
    store.update_task(run["id"], {"status": "done"})
    changed = client.get(f"{path}?view=record", headers=headers)
    assert changed.status_code == 200 and changed.json()["hasRunningOccurrence"] is False


def test_automation_page_bounds_legacy_computer_placement(project_context):
    app, client, project = project_context
    store = app.state.task_store
    owner = project["ownerUserId"]
    computer = "device:automation:current"
    elsewhere = "device:automation:other"
    base = {"ownerUserId": owner, "isRoutine": True}
    local = store.create_task({**base, "title": "Here", "computerId": computer})
    remote = store.create_task({**base, "title": "Elsewhere"})
    thread = app.state.session_store.create_session({
        "ownerUserId": owner, "workspacePath": "", "taskGoal": "Old Automation Thread",
        "participants": ["human", "codex"], "computerId": elsewhere,
    })
    store.link_session(remote["id"], thread["id"])
    old = [store.create_task({**base, "title": f"Legacy {i}"}) for i in range(12)]
    params = {"view": "summary", "scope": "automations", "layout": "list", "computerId": computer}
    first = client.get("/api/v1/tasks", params=params).json()
    second = client.get("/api/v1/tasks", params={**params, "unplacedPage": 2}).json()
    assert [row["id"] for row in first["tasks"]] == [local["id"]]
    assert len(first["unplaced"]["tasks"]) == 10
    assert second["unplaced"]["total"] == 12 and second["unplaced"]["page"] == 2
    assert {row["id"] for row in first["unplaced"]["tasks"] + second["unplaced"]["tasks"]} == {row["id"] for row in old}


def test_routine_ledger_pages_by_schedule_and_only_replays_visible_runs(project_context, monkeypatch):
    app, client, project = project_context
    store = app.state.task_store
    owner = project["ownerUserId"]
    routine = store.create_task({"title": "Ledger", "isRoutine": True, "ownerUserId": owner})
    ids = []
    for day in (4, 1, 3, 2):
        occurrence = store.create_task({
            "title": "Run", "ownerUserId": owner, "sourceRoutineId": routine["id"],
            "scheduledFor": f"2026-10-0{day}",
        })
        ids.append(occurrence["id"])
        store.append_event(routine["id"], relay_task_event(
            "task.occurrence_created", routine["id"], {"occurrenceId": occurrence["id"]},
        ))

    replays = []
    get_task = store.get_task

    def record_replay(task_id):
        replays.append(task_id)
        return get_task(task_id)

    monkeypatch.setattr(store, "get_task", record_replay)
    path = f"/api/v1/tasks/{routine['id']}/runs"
    first = client.get(path, params={"limit": 2}).json()
    assert [row["taskId"] for row in first["runs"]] == [ids[0], ids[2]]
    assert replays == [ids[0], ids[2]]
    replays.clear()
    second = client.get(path, params={"limit": 2, "before": first["nextCursor"]}).json()
    assert [row["taskId"] for row in second["runs"]] == [ids[3], ids[1]]
    assert second["nextCursor"] is None
    assert replays == [ids[3], ids[1]]


def test_activity_pages_preserve_status_context_and_skip_task_replay(project_context, monkeypatch):
    app, client, project = project_context
    task = _task(client, project, "Activity pages")
    store = app.state.task_store
    for status in ("running", "waiting_for_human", "running", "review"):
        store.append_event(task["id"], relay_task_event("task.status", task["id"], {"status": status}))
    route = f"/api/v1/tasks/{task['id']}/events"
    complete = client.get(route).json()["events"]
    assert len(complete) > 3

    def no_replay(*_args, **_kwargs):
        pytest.fail("The activity page must not replay the event log")

    monkeypatch.setattr(store, "get_task", no_replay)
    first = client.get(route, params={"view": "activity", "limit": 2}).json()
    assert [event["status"] for event in first["events"]] == ["running", "review"]
    assert first["previousStatus"] == "waiting_for_human"
    second = client.get(route, params={"view": "activity", "limit": 2, "before": first["nextBefore"]}).json()
    assert [event["status"] for event in second["events"]] == ["running", "waiting_for_human"]
    assert second["previousStatus"] == "backlog"
    assert TestClient(app).get(route, params={"view": "activity"}).status_code == 401


@pytest.mark.parametrize("snapshot_only", [False, True])
def test_task_lifecycle_retains_status_and_thread_boundaries(project_context, monkeypatch, snapshot_only):
    app, client, project = project_context
    task_id = _task(client, project, "Thread timeline")["id"]
    store = app.state.task_store
    thread = app.state.session_store.create_session({
        "workspacePath": "", "taskGoal": "Work on the Task",
        "participants": ["human", "codex"], "ownerUserId": project["ownerUserId"],
    })
    store.record_activity(task_id, "A long event outside the status timeline. " * 500)
    for event_type, payload in (
        ("task.execution.claimed", {"requestId": "request-1", "expectedRevision": 0}),
        ("task.status", {"status": "running"}),
        ("task.session_linked", {"sessionId": thread["id"]}),
    ):
        store.append_event(task_id, relay_task_event(event_type, task_id, payload))
    route = f"/api/v1/tasks/{task_id}/events"
    full = client.get(route).json()["events"]
    expected = full[-3:]
    if snapshot_only:
        snapshot = store.get_task(task_id)
        with store.engine.begin() as conn:
            conn.execute(update(store.tasks).where(store.tasks.c.id == task_id).values(snapshot=snapshot))
            conn.execute(delete(store.events).where(store.events.c.task_id == task_id))

    def reject_replay(*_args, **_kwargs):
        pytest.fail("The thread lifecycle should authorize and read events without replaying Tasks")

    monkeypatch.setattr(store, "get_task", reject_replay)
    response = client.get(route, params={"view": "lifecycle"})
    assert response.status_code == 200
    assert response.json() == {"events": expected}
    assert len(response.content) < 1_000
    assert TestClient(app).get(route, params={"view": "lifecycle"}).status_code == 401


def test_snapshot_only_task_activity_honors_limit_and_cursor(project_context, monkeypatch):
    app, client, project = project_context
    task_id = _task(client, project, "Snapshot-only Activity")["id"]
    store = app.state.task_store
    for status in ("running", "waiting_for_human", "running", "review"):
        store.append_event(task_id, relay_task_event("task.status", task_id, {"status": status}))
    snapshot = store.get_task(task_id)
    with store.engine.begin() as conn:
        conn.execute(update(store.tasks).where(store.tasks.c.id == task_id).values(snapshot=snapshot))
        conn.execute(delete(store.events).where(store.events.c.task_id == task_id))

    def reject_task_replay(*_args, **_kwargs):
        pytest.fail("Activity should authorize from the Task header without replaying events")

    monkeypatch.setattr(store, "get_task_record", reject_task_replay)
    route = f"/api/v1/tasks/{task_id}/events"
    first = client.get(route, params={"view": "activity", "limit": 2}).json()
    assert [event["status"] for event in first["events"]] == ["running", "review"]
    assert first["previousStatus"] == "waiting_for_human"
    second = client.get(route, params={"view": "activity", "limit": 2, "before": first["nextBefore"]}).json()
    assert [event["status"] for event in second["events"]] == ["running", "waiting_for_human"]
    last = client.get(route, params={"view": "activity", "limit": 2, "before": second["nextBefore"]}).json()
    assert [event["type"] for event in last["events"]] == ["task.created"]
    assert last["nextBefore"] is None
    assert client.get(route).json()["events"] == snapshot["events"]
    other = TestClient(app)
    assert other.post("/api/v1/auth/login", json={
        "username": "admin", "password": "kestrel-vault-7719",
    }).status_code == 200
    assert other.get(route, params={"view": "activity"}).status_code == 403


@pytest.mark.parametrize("stored_version", [0, 9])
def test_first_snapshot_only_task_write_preserves_history(project_context, stored_version):
    app, client, project = project_context
    task_id = _task(client, project, "Legacy Task")["id"]
    store = app.state.task_store
    for message in ("First", "Second", "Third"):
        store.record_activity(task_id, message)
    snapshot = store.get_task(task_id)
    with store.engine.begin() as conn:
        conn.execute(update(store.tasks).where(store.tasks.c.id == task_id).values(
            snapshot=snapshot, version=stored_version,
        ))
        conn.execute(delete(store.events).where(store.events.c.task_id == task_id))

    path = f"/api/v1/tasks/{task_id}"
    options = {"view": "activity", "limit": 2}
    first = client.get(f"{path}/events", params=options).json()
    for title in ("Edited once", "Edited twice"):
        edited = client.patch(path, json={"title": title})
        assert edited.status_code == 200, edited.text
        assert edited.json()["title"] == title
    history = client.get(f"{path}/events").json()["events"]
    assert history[:-2] == snapshot["events"]
    assert [event["type"] for event in history[-2:]] == ["task.updated", "task.updated"]
    older = client.get(f"{path}/events", params={**options, "before": first["nextBefore"]}).json()
    assert older["events"] == snapshot["events"][:2]
    assert older["nextBefore"] is None


def test_set_read_and_clear_prerequisites(project_context):
    _app, client, project = project_context
    first, second = _task(client, project, "Design"), _task(client, project, "Build")

    response = _set(client, second, [first["id"]])

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["prerequisiteTaskIds"] == [first["id"]]
    assert body["waitingOn"] == [first["id"]]
    assert client.get(f"/api/v1/tasks/{first['id']}").json()["unblocks"] == [second["id"]]
    listed = {task["id"]: task for task in client.get("/api/v1/tasks").json()["tasks"]}
    assert listed[second["id"]]["waitingOn"] == [first["id"]]
    assert listed[first["id"]]["waitingOn"] == []

    cleared = _set(client, second, [])
    assert cleared.status_code == 200
    assert "prerequisiteTaskIds" not in cleared.json()
    assert client.get(f"/api/v1/tasks/{first['id']}").json()["unblocks"] == []


def test_cycle_self_and_scope_are_refused(project_context):
    _app, client, project = project_context
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200

    cycle = _set(client, first, [second["id"]])
    assert (cycle.status_code, cycle.json()["detail"]) == (409, "task_prerequisite_cycle")
    own = _set(client, first, [first["id"]])
    assert (own.status_code, own.json()["detail"]) == (400, "task_prerequisite_self")
    intake = client.post("/api/v1/tasks", json={"title": "Loose"}).json()
    scope = _set(client, first, [intake["id"]])
    assert (scope.status_code, scope.json()["detail"]) == (409, "task_prerequisite_scope")
    bad = client.put(f"/api/v1/tasks/{first['id']}/prerequisites", json={"prerequisiteTaskIds": "x"})
    assert bad.status_code == 400


def test_dispatch_queue_holds_a_task_until_its_prerequisite_is_done(project_context):
    app, client, project = project_context
    store = app.state.task_store
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200
    for task in (first, second):
        store.update_task(task["id"], {"status": "assigned"})

    queued = {task["id"] for task in store.list_dispatchable_tasks()}
    assert first["id"] in queued and second["id"] not in queued

    store.update_task(first["id"], {"status": "done"})
    assert second["id"] in {task["id"] for task in store.list_dispatchable_tasks()}


def test_deleting_a_prerequisite_releases_its_dependent(project_context):
    app, client, project = project_context
    store = app.state.task_store
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200
    store.update_task(second["id"], {"status": "assigned"})

    store.delete_task(first["id"])

    assert second["id"] in {task["id"] for task in store.list_dispatchable_tasks()}
    assert client.get(f"/api/v1/tasks/{second['id']}").json()["waitingOn"] == []


def test_manual_start_is_refused_while_waiting(project_context):
    _app, client, project = project_context
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200

    response = client.post(f"/api/v1/tasks/{second['id']}/runs", json={})

    assert (response.status_code, response.json()["detail"]) == (409, "task_prerequisites_open")


def test_pickup_and_claim_refuse_a_waiting_task(project_context):
    app, client, project = project_context
    store = app.state.task_store
    first, second = _task(client, project, "A"), _task(client, project, "B")
    assert _set(client, second, [first["id"]]).status_code == 200
    store.update_task(second["id"], {"status": "assigned", "assignedAgent": "codex"})

    pickup = client.post(f"/api/v1/tasks/{second['id']}/pickups", json={"agentId": "x"})

    assert (pickup.status_code, pickup.json()["detail"]) == (409, "task_prerequisites_open")
    assert store.claim_task_for_dispatch(second["id"], "codex") is None


def test_list_dependency_summary_respects_task_and_project_access(project_context):
    app, client, project = project_context
    store = app.state.task_store
    bob = app.state.auth_store.ensure_user("bob", display_name="Sam Lee")
    upstream = store.create_task({"title": "Bob's upstream work", "description": "private evidence", "ownerUserId": bob["id"], "assigneeUserId": bob["id"], "projectId": project["id"]})
    dependent = _task(client, project, "Alice's dependent work")
    assert _set(client, dependent, [upstream["id"]]).status_code == 200
    rows = {t["id"]: t for t in client.get("/api/v1/tasks?view=summary").json()["tasks"]}
    assert upstream["id"] not in rows
    assert rows[dependent["id"]]["waitingOnSummaries"] == []
    assert client.get(f"/api/v1/tasks/{upstream['id']}").status_code == 403

    foreign = app.state.project_store.create_project(bob["id"], {
        "name": "Foreign Project", "computerId": project["computerId"], "members": [],
    })
    scope = {"ownerUserId": project["ownerUserId"], "projectId": foreign["id"]}
    own_upstream = store.create_task({**scope, "title": "Visible Task in a foreign Project"})
    own_dependent = store.create_task({**scope, "title": "Dependent Task in a foreign Project"})
    store.set_task_prerequisites(own_dependent["id"], [own_upstream["id"]])
    rows = {t["id"]: t for t in client.get("/api/v1/tasks?view=summary").json()["tasks"]}
    assert own_upstream["id"] in rows
    assert rows[own_dependent["id"]]["waitingOn"] == [own_upstream["id"]]
    assert rows[own_dependent["id"]]["waitingOnSummaries"] == []

    local = _task(client, project, "Visible Task in an owned Project")
    assert _set(client, dependent, [local["id"]]).status_code == 200
    rows = {t["id"]: t for t in client.get("/api/v1/tasks?view=summary").json()["tasks"]}
    assert [summary["id"] for summary in rows[dependent["id"]]["waitingOnSummaries"]] == [local["id"]]
    app.state.project_store.archive_project(project["id"], expected_version=project["version"])
    rows = {t["id"]: t for t in client.get("/api/v1/tasks?view=summary").json()["tasks"]}
    assert rows[dependent["id"]]["waitingOn"] == [local["id"]]
    assert rows[dependent["id"]]["waitingOnSummaries"] == []


def test_list_reuses_prerequisites_already_in_the_task_page(project_context, monkeypatch):
    app, client, project = project_context
    upstream = _task(client, project, "Design")
    dependent = _task(client, project, "Build")
    assert _set(client, dependent, [upstream["id"]]).status_code == 200
    store = app.state.task_store
    list_summaries = store.list_task_summaries
    extra_reads = []

    def record_lookup(**options):
        if options.get("task_ids"):
            extra_reads.append(options["task_ids"])
        return list_summaries(**options)

    monkeypatch.setattr(store, "list_task_summaries", record_lookup)
    path = "/api/v1/tasks?view=summary"
    full = {task["id"]: task for task in client.get(path).json()["tasks"]}
    expected = full[dependent["id"]]["waitingOnSummaries"]
    assert [summary["id"] for summary in expected] == [upstream["id"]]
    assert extra_reads == []

    [limited] = client.get(f"{path}&limit=1").json()["tasks"]
    assert limited["id"] == dependent["id"]
    assert limited["waitingOnSummaries"] == expected
    assert extra_reads == [[upstream["id"]]]


def test_task_record_view_omits_history_and_preserves_prerequisites(project_context, monkeypatch):
    app, client, project = project_context
    upstream = _task(client, project, "Design")
    dependent = _task(client, project, "Build")
    assert _set(client, dependent, [upstream["id"]]).status_code == 200
    store = app.state.task_store
    for index in range(20):
        store.update_task(dependent["id"], {"description": f"Revision {index}: " + "x" * 1000})
    store.record_activity(dependent["id"], "Activity already shown in its own tab. " * 500)

    path = f"/api/v1/tasks/{dependent['id']}"
    full = client.get(path)
    assert full.status_code == 200
    assert len(full.json()["events"]) > 20
    assert full.json()["waitingOn"] == [upstream["id"]]

    def reject_history_read(*_args):
        raise AssertionError("the record view should read the current snapshot")

    monkeypatch.setattr(store, "_events_for_task", reject_history_read)
    response = client.get(f"{path}?view=record")
    assert response.status_code == 200
    result = response.json()
    assert "events" not in result
    assert "activity" not in result
    assert "lastActivity" not in result
    assert response.headers["cache-control"] == "no-store"
    unchanged = client.get(f"{path}?view=record", headers={"If-None-Match": response.headers["etag"]})
    assert unchanged.status_code == 304 and unchanged.content == b""
    assert result["eventCount"] == len(full.json()["events"])
    assert result["description"] == full.json()["description"]
    assert result["waitingOn"] == [upstream["id"]]
    assert len(response.content) < len(full.content) // 4
    assert TestClient(app).get(f"{path}?view=record").status_code == 401


def test_task_record_view_rebuilds_a_legacy_snapshot(project_context):
    app, client, project = project_context
    task = _task(client, project, "Before editing")
    store = app.state.task_store
    latest = store.update_task(task["id"], {"title": "Edited"})
    with store.engine.begin() as conn:
        conn.execute(update(store.tasks).where(store.tasks.c.id == task["id"]).values(snapshot={
            **{key: value for key, value in task.items() if key != "eventCount"},
        }))
    response = client.get(f"/api/v1/tasks/{task['id']}?view=record")
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Edited"
    assert body["eventCount"] == len(latest["events"])
    assert "events" not in body
