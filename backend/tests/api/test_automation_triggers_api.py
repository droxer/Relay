from __future__ import annotations

from datetime import datetime, timezone
from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.automations.model import LEGACY_FIELDS

from test_tasks import _bootstrap_admin, _create_agent, _create_user

WEBHOOK = {"kind": "webhook"}
ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}
DAILY_9 = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "09:00"}}}]


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
        "assignedAgentId": agent["id"], "isRoutine": True, "routineState": "active",
        "routineTriggers": DAILY_9, **extra,
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_event_trigger_round_trips_and_clears_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent, routineTriggers=[ON_BLOCKED])
        assert created["routineTriggers"] == [ON_BLOCKED]
        assert "routineNextRunAt" not in created
        assert client.app.state.task_store.list_unseeded_schedules() == []


def test_schedule_routine_has_a_next_run_and_no_legacy_fields(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent)
        assert created["routineNextRunAt"]
        assert not set(LEGACY_FIELDS) & set(created)


def test_switching_trigger_kind_moves_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent)
        to_webhook = client.patch(f"/api/v1/tasks/{created['id']}", json={"routineTriggers": [WEBHOOK]})
        assert to_webhook.status_code == 200, to_webhook.text
        assert "routineNextRunAt" not in to_webhook.json()
        back = client.patch(f"/api/v1/tasks/{created['id']}", json={"routineTriggers": DAILY_9})
        assert back.json()["routineTriggers"] == DAILY_9
        assert back.json()["routineNextRunAt"] > datetime.now(timezone.utc).isoformat()


def test_invalid_trigger_is_a_400(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        response = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
            "routineTriggers": [{"kind": "task_event", "on": "completed"}],
        })
        assert response.status_code == 400
        missing = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
            "routineTriggers": [DAILY_9[0], {"kind": "task_event", "on": "created", "filters": {"projectId": "nope"}}],
        })
        assert missing.status_code == 400
        assert missing.json()["detail"] == "routineTriggers[1] filters.projectId does not exist."


def test_scope_filters_require_owner_access_on_create_and_patch(monkeypatch) -> None:
    from test_tasks import _login
    from issue_projects import project_for_agents
    with TemporaryDirectory() as root:
        client, alice_agent = _client(monkeypatch, root)
        _create_user(client, "bob", employee_id="bob")
        bob_agent = _create_agent(client, "bob")
        project = project_for_agents(client.app.state.project_store, "bob", [bob_agent])
        routine = _routine(client, alice_agent, routineTriggers=[ON_BLOCKED])
        _login(client, "alice")
        trigger = {"kind": "task_event", "on": "created", "filters": {"projectId": project["id"]}}
        assert client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTriggers": [trigger]}).status_code == 403
        response = client.post("/api/v1/tasks", json={"title": "Watch Bob", "isRoutine": True,
            "routineTriggers": [trigger], "assignedAgentId": alice_agent["id"]})
        assert response.status_code == 403


def test_run_now_queues_through_matcher_and_cap(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine = _routine(client, agent, routineTriggers=[])
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
        paused = client.app.state.task_store.get_task(routine["id"])
        assert (paused["routineState"], paused["routinePauseReason"]) == ("paused_by_relay", "rate_limited")


def test_reenable_rate_limited_automation_starts_a_fresh_window(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        monkeypatch.setenv("RELAY_AUTOMATION_MAX_RUNS_PER_HOUR", "1")
        routine = _routine(client, agent, routineTriggers=[])
        path = f"/api/v1/tasks/{routine['id']}"
        client.post(path + "/runs", json={})
        store = client.app.state.task_store
        first_id = store.get_task(routine["id"])["occurrenceIds"][0]
        store.update_task(first_id, {"status": "done"})
        client.post(path + "/runs", json={})
        assert client.patch(path, json={"routineState": "active"}).status_code == 200
        client.post(path + "/runs", json={})
        assert store.get_task(routine["id"])["routineState"] == "active"
        assert len(store.get_task(routine["id"])["occurrenceIds"]) == 2


def test_scope_team_and_agent_filters_use_owner_not_admin_access(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        _create_user(client, "bob", employee_id="bob")
        foreign = _create_agent(client, "bob")
        team = client.app.state.team_store.create_team("bob", {
            "name": "Bob team", "leadAgentId": foreign["id"], "memberAgentIds": [foreign["id"]],
        })
        routine = _routine(client, agent, routineTriggers=[ON_BLOCKED])
        for filters in ({"assignedAgentId": foreign["id"]}, {"assignedTeamId": team["id"]}):
            response = client.patch(f"/api/v1/tasks/{routine['id']}", json={
                "routineTriggers": [{"kind": "task_event", "on": "created", "filters": filters}],
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
        routine = _routine(client, agent, routineTriggers=[ON_BLOCKED])
        response = client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTriggers": [{
            "kind": "task_event", "on": "created", "filters": {"projectId": project["id"], "assignedTeamId": team["id"]},
        }]})
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
        response = client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTriggers": [scoped]})
        assert response.status_code == 400
        assert "owner" in response.json()["detail"]
        unscoped = client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTriggers": [ON_BLOCKED]})
        assert unscoped.status_code == 200, unscoped.text


def test_run_now_while_a_run_is_queued_does_not_start_another_later(monkeypatch) -> None:
    from relay.automations.service import AutomationService
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine = _routine(client, agent, routineTriggers=[])
        url = f"/api/v1/tasks/{routine['id']}/runs"
        assert client.post(url, json={}).status_code == 202
        assert client.post(url, json={}).status_code == 202
        store = client.app.state.task_store
        [occurrence_id] = store.get_task(routine["id"])["occurrenceIds"]
        assert client.app.state.automation_store.get_state(routine["id"])["pending"] is False
        store.update_task(occurrence_id, {"status": "done"})
        AutomationService(task_store=store, session_store=client.app.state.session_store,
                          automation_store=client.app.state.automation_store,
                          project_store=client.app.state.project_store).tick(datetime.now(timezone.utc))
        assert len(store.get_task(routine["id"])["occurrenceIds"]) == 1


def _post(client: TestClient, **body):
    return client.post("/api/v1/tasks", json={
        "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice", **body,
    })


def test_create_v2_automation_computes_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _post(client, title="Digest", isRoutine=True, assignedAgentId=agent["id"],
                     routineState="active", routineTriggers=DAILY_9).json()
        assert task["routineState"] == "active"
        assert task["routineNextRunAt"].endswith("T09:00:00+00:00")


@pytest.mark.parametrize("field", ["routineCadence", "routineType", "routineEnabled", "routineTrigger",
                                   "routineNextRunDate", "routineDisabledReason"])
def test_legacy_fields_rejected(monkeypatch, field) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        response = _post(client, title="x", isRoutine=True, **{field: "daily"})
        assert response.status_code == 400
        assert field in response.json()["detail"]
        routine = _routine(client, agent)
        patched = client.patch(f"/api/v1/tasks/{routine['id']}", json={field: "daily"})
        assert patched.status_code == 400
        assert field in patched.json()["detail"]


def test_owner_cannot_set_paused_by_relay(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        response = _post(client, title="x", isRoutine=True, routineTriggers=[], routineState="paused_by_relay")
        assert response.status_code == 400 and "only Relay" in response.json()["detail"]


def test_six_triggers_rejected(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        response = _post(client, title="x", isRoutine=True, routineTriggers=DAILY_9 * 6)
        assert response.status_code == 400 and "at most 5" in response.json()["detail"]


def test_bad_schedule_names_the_path(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        bad = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "9am"}}}]
        response = _post(client, title="x", isRoutine=True, routineTriggers=bad)
        assert response.status_code == 400 and "routineTriggers[0].schedule.repeat.at" in response.json()["detail"]


def test_unknown_trigger_keys_keep_their_subject(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        unknown = _post(client, title="x", isRoutine=True,
                        routineTriggers=[{"kind": "task_event", "on": "created", "zz": 1}])
        assert unknown.json()["detail"] == "routineTriggers[0] has unknown keys: zz."
        webhook = _post(client, title="x", isRoutine=True, routineTriggers=[{"kind": "webhook", "on": "created"}])
        assert webhook.json()["detail"] == "routineTriggers[0] webhook trigger takes no on or filters."


def test_enabling_needs_a_target(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        untargeted = _post(client, title="x", isRoutine=True, routineTriggers=DAILY_9)
        assert untargeted.status_code == 201, untargeted.text
        assert untargeted.json()["routineState"] == "paused"
        enable = client.patch(f"/api/v1/tasks/{untargeted.json()['id']}", json={"routineState": "active"})
        assert enable.status_code == 400
        assert _post(client, title="x", isRoutine=True, routineTriggers=DAILY_9,
                     routineState="active").status_code == 400


def test_pause_clears_next_run_and_resume_recomputes(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent)
        paused = client.patch(f"/api/v1/tasks/{task['id']}", json={"routineState": "paused"}).json()
        assert paused["routineState"] == "paused"
        assert "routineNextRunAt" not in paused
        resumed = client.patch(f"/api/v1/tasks/{task['id']}", json={"routineState": "active"}).json()
        assert resumed["routineNextRunAt"].endswith("T09:00:00+00:00")


def test_title_only_patch_leaves_routine_fields_alone(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent)
        renamed = client.patch(f"/api/v1/tasks/{task['id']}", json={"title": "Renamed"}).json()
        assert renamed["routineNextRunAt"] == task["routineNextRunAt"]
        assert renamed["routineTriggers"] == DAILY_9


def test_legacy_routine_reads_as_v2_and_patches_keep_its_schedule(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        legacy = client.app.state.task_store.create_task({
            "title": "Old", "isRoutine": True, "routineCadence": "weekly", "routineType": "task",
            "routineNextRunDate": "2030-01-02", "routineEnabled": True,
            "assignedAgent": agent["executorKind"], "assignedAgentId": agent["id"], "ownerEmployeeId": "alice",
        })
        current = client.get(f"/api/v1/tasks/{legacy['id']}").json()
        assert current["routineState"] == "active"
        assert not set(LEGACY_FIELDS) & set(current)
        listed = next(task for task in client.get("/api/v1/tasks").json()["tasks"] if task["id"] == legacy["id"])
        assert not set(LEGACY_FIELDS) & set(listed)
        saved = client.patch(f"/api/v1/tasks/{legacy['id']}", json={
            "title": "Renamed", "routineTriggers": current["routineTriggers"], "routineState": current["routineState"],
        }).json()
        assert saved["routineTriggers"] == current["routineTriggers"]
        assert saved["routineTriggers"][0]["schedule"]["repeat"] == {"every": "week", "at": "00:00", "days": [3]}
        assert saved["routineNextRunAt"]


def test_capability_off_rejects_event_triggers(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        monkeypatch.setenv("RELAY_AUTOMATION_TRIGGERS_ENABLED", "0")
        response = _post(client, title="x", isRoutine=True, routineTriggers=[WEBHOOK])
        assert response.status_code == 400
        assert _post(client, title="x", isRoutine=True, routineTriggers=DAILY_9).status_code == 201


def test_run_now_on_paused_automation_runs_and_keeps_it_paused(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent, routineState="paused", routineTriggers=[])
        response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
        assert response.status_code == 202
        assert response.json().get("dispatch", {}).get("state") != "rejected"
        routine = client.app.state.task_store.get_task(task["id"])
        assert len(routine["occurrenceIds"]) == 1
        assert routine["routineState"] == "paused"


def test_admin_settings_report_the_triggers_capability(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        assert client.get("/api/v1/admin/settings").json()["capabilities"]["automationTriggers"] is True
        monkeypatch.setenv("RELAY_AUTOMATION_TRIGGERS_ENABLED", "0")
        assert client.get("/api/v1/admin/settings").json()["capabilities"]["automationTriggers"] is False
