from __future__ import annotations

from datetime import date
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from relay.app import create_app

from test_tasks import _bootstrap_admin, _create_agent, _create_user

WEBHOOK = {"kind": "webhook"}
ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


def _client(monkeypatch, root: str) -> tuple[TestClient, dict]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    client = TestClient(create_app(root))
    _bootstrap_admin(client)
    _create_user(client, "alice", employee_id="alice")
    return client, _create_agent(client, "alice")


def _routine(client: TestClient, agent: dict, **extra) -> dict:
    response = client.post("/api/v1/tasks", json={
        "title": "Triage failures", "description": "Look into it.",
        "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
        "assignedAgentId": agent["id"], "isRoutine": True, "routineEnabled": True,
        "routineCadence": "weekly", **extra,
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_event_trigger_round_trips_and_clears_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent, routineTrigger=ON_BLOCKED)
        assert created["routineTrigger"] == ON_BLOCKED
        assert "routineNextRunDate" not in created
        assert client.app.state.task_store.list_due_routines("2099-01-01") == []


def test_routine_without_trigger_reads_as_schedule(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent)
        assert "routineTrigger" not in created
        assert created["routineNextRunDate"]


def test_switching_trigger_kind_moves_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent)
        to_webhook = client.patch(f"/api/v1/tasks/{created['id']}", json={"routineTrigger": WEBHOOK})
        assert to_webhook.status_code == 200, to_webhook.text
        assert "routineNextRunDate" not in to_webhook.json()
        back = client.patch(f"/api/v1/tasks/{created['id']}", json={"routineTrigger": {"kind": "schedule"}})
        assert back.json()["routineTrigger"] == {"kind": "schedule"}
        assert back.json()["routineNextRunDate"] > date.today().isoformat()


def test_invalid_trigger_is_a_400(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        response = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
            "routineTrigger": {"kind": "task_event", "on": "completed"},
        })
        assert response.status_code == 400
        missing = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
            "routineTrigger": {"kind": "task_event", "on": "created", "filters": {"projectId": "nope"}},
        })
        assert missing.status_code == 400
        assert "projectId" in missing.json()["detail"]


def test_scope_filters_require_owner_access_on_create_and_patch(monkeypatch) -> None:
    from test_tasks import _login
    from issue_projects import project_for_agents
    with TemporaryDirectory() as root:
        client, alice_agent = _client(monkeypatch, root)
        _create_user(client, "bob", employee_id="bob")
        bob_agent = _create_agent(client, "bob")
        project = project_for_agents(client.app.state.project_store, "bob", [bob_agent])
        routine = _routine(client, alice_agent, routineTrigger=ON_BLOCKED)
        _login(client, "alice")
        trigger = {"kind": "task_event", "on": "created", "filters": {"projectId": project["id"]}}
        assert client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTrigger": trigger}).status_code == 403
        response = client.post("/api/v1/tasks", json={"title": "Watch Bob", "isRoutine": True,
            "routineTrigger": trigger, "assignedAgentId": alice_agent["id"]})
        assert response.status_code == 403


def test_run_now_queues_through_matcher_and_cap(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine = _routine(client, agent, routineTrigger={"kind": "manual"})
        monkeypatch.setenv("RELAY_AUTOMATION_MAX_RUNS_PER_HOUR", "1")
        response = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})
        assert response.status_code == 202
        state = client.app.state.automation_store.get_state(routine["id"])
        assert state["fired_count"] == 1
        first_id = client.app.state.task_store.get_task(routine["id"])["occurrenceIds"][0]
        client.app.state.task_store.update_task(first_id, {"status": "done"})
        response = client.post(f"/api/v1/tasks/{routine['id']}/runs", json={})
        assert response.status_code == 202
        assert response.json()["dispatch"]["code"] == "rate_limited"
        assert not client.app.state.task_store.get_task(routine["id"])["routineEnabled"]


def test_reenable_rate_limited_automation_starts_a_fresh_window(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        monkeypatch.setenv("RELAY_AUTOMATION_MAX_RUNS_PER_HOUR", "1")
        routine = _routine(client, agent, routineTrigger={"kind": "manual"})
        path = f"/api/v1/tasks/{routine['id']}"
        client.post(path + "/runs", json={})
        store = client.app.state.task_store
        first_id = store.get_task(routine["id"])["occurrenceIds"][0]
        store.update_task(first_id, {"status": "done"})
        client.post(path + "/runs", json={})
        assert client.patch(path, json={"routineEnabled": True}).status_code == 200
        client.post(path + "/runs", json={})
        assert store.get_task(routine["id"])["routineEnabled"]
        assert len(store.get_task(routine["id"])["occurrenceIds"]) == 2


def test_scope_team_and_agent_filters_use_owner_not_admin_access(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        _create_user(client, "bob", employee_id="bob")
        foreign = _create_agent(client, "bob")
        team = client.app.state.team_store.create_team("bob", {
            "name": "Bob team", "leadAgentId": foreign["id"], "memberAgentIds": [foreign["id"]],
        })
        routine = _routine(client, agent, routineTrigger=ON_BLOCKED)
        for filters in ({"assignedAgentId": foreign["id"]}, {"assignedTeamId": team["id"]}):
            response = client.patch(f"/api/v1/tasks/{routine['id']}", json={
                "routineTrigger": {"kind": "task_event", "on": "created", "filters": filters},
            })
            assert response.status_code == 403


def test_project_and_team_filters_require_same_computer(monkeypatch) -> None:
    from issue_projects import project_for_agents
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        project = project_for_agents(client.app.state.project_store, "alice", [agent])
        # The agent has no placement on the project's computer. Project/task
        # admission must also be applied to scoped trigger teams.
        team = client.app.state.team_store.create_team("alice", {
            "name": "Unplaced team", "leadAgentId": agent["id"], "memberAgentIds": [agent["id"]],
        })
        routine = _routine(client, agent, routineTrigger=ON_BLOCKED)
        response = client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTrigger": {
            "kind": "task_event", "on": "created", "filters": {"projectId": project["id"], "assignedTeamId": team["id"]},
        }})
        assert response.status_code == 400
        assert response.json()["detail"] == "project_team_off_computer"


def test_ownerless_task_can_still_be_edited(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        task = client.app.state.task_store.create_task({"title": "legacy ownerless"})
        response = client.patch(f"/api/v1/tasks/{task['id']}", json={"title": "renamed"})
        assert response.status_code == 200, response.text
        assert response.json()["title"] == "renamed"


def test_ownerless_automation_cannot_filter_by_scope(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine = client.app.state.task_store.create_task({
            "title": "legacy", "isRoutine": True, "routineEnabled": True, "routineCadence": "weekly",
            "assignedAgent": agent["executorKind"], "assignedAgentId": agent["id"],
        })
        scoped = {"kind": "task_event", "on": "created", "filters": {"assignedAgentId": agent["id"]}}
        response = client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTrigger": scoped})
        assert response.status_code == 400
        assert "owner" in response.json()["detail"]
        unscoped = client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTrigger": ON_BLOCKED})
        assert unscoped.status_code == 200, unscoped.text


def test_run_now_while_a_run_is_queued_does_not_start_another_later(monkeypatch) -> None:
    from relay.automations.matcher import AutomationMatcher
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine = _routine(client, agent, routineTrigger={"kind": "manual"})
        url = f"/api/v1/tasks/{routine['id']}/runs"
        assert client.post(url, json={}).status_code == 202
        assert client.post(url, json={}).status_code == 202
        store = client.app.state.task_store
        [occurrence_id] = store.get_task(routine["id"])["occurrenceIds"]
        assert client.app.state.automation_store.get_state(routine["id"])["pending"] is False
        store.update_task(occurrence_id, {"status": "done"})
        AutomationMatcher(task_store=store, session_store=client.app.state.session_store,
                          automation_store=client.app.state.automation_store).run()
        assert len(store.get_task(routine["id"])["occurrenceIds"]) == 1
