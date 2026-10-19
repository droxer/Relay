from __future__ import annotations

from datetime import datetime, UTC
from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.automations.model import LEGACY_FIELDS

from test_tasks import _bootstrap_admin, _create_agent, _create_account, _login
from user_ids import user_id

ALICE = user_id("alice")
BOB = user_id("bob")

WEBHOOK = {"kind": "webhook"}
ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}
DAILY_9 = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "09:00"}}}]


def _client(monkeypatch, root: str) -> tuple[TestClient, dict]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    client = TestClient(create_app(root))
    _bootstrap_admin(client)
    _create_account(client, "alice", user_id="alice")
    return client, _create_agent(client, ALICE)


def _routine(client: TestClient, agent: dict, **extra) -> dict:
    response = client.post("/api/v1/tasks", json={
        "title": "Triage failures", "description": "Look into it.",
        "ownerUserId": ALICE, "assigneeUserId": ALICE,
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
        assert back.json()["routineNextRunAt"] > datetime.now(UTC).isoformat()


def test_invalid_trigger_is_a_400(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        response = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "ownerUserId": ALICE, "assigneeUserId": ALICE,
            "routineTriggers": [{"kind": "task_event", "on": "completed"}],
        })
        assert response.status_code == 400
        missing = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "ownerUserId": ALICE, "assigneeUserId": ALICE,
            "routineTriggers": [DAILY_9[0], {"kind": "task_event", "on": "created", "filters": {"projectId": "nope"}}],
        })
        assert missing.status_code == 400
        assert missing.json()["detail"] == "routineTriggers[1] filters.projectId does not exist."


def test_scope_filters_require_owner_access_on_create_and_patch(monkeypatch) -> None:
    from test_tasks import _login
    from issue_projects import project_for_agents
    with TemporaryDirectory() as root:
        client, alice_agent = _client(monkeypatch, root)
        _create_account(client, "bob", user_id="bob")
        bob_agent = _create_agent(client, BOB)
        project = project_for_agents(client.app.state.project_store, BOB, [bob_agent])
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
        _create_account(client, "bob", user_id="bob")
        foreign = _create_agent(client, BOB)
        team = client.app.state.team_store.create_team(BOB, {
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
        project = project_for_agents(client.app.state.project_store, ALICE, [agent])
        # The agent has no placement on the project's computer. Project/task
        # admission must also be applied to scoped trigger teams.
        team = client.app.state.team_store.create_team(ALICE, {
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
                          project_store=client.app.state.project_store).tick(datetime.now(UTC))
        assert len(store.get_task(routine["id"])["occurrenceIds"]) == 1


def _post(client: TestClient, **body):
    return client.post("/api/v1/tasks", json={
        "ownerUserId": ALICE, "assigneeUserId": ALICE, **body,
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
            "assignedAgent": agent["executorKind"], "assignedAgentId": agent["id"], "ownerUserId": ALICE,
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


def test_users_learn_the_triggers_capability_from_auth_me(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        _login(client, "alice")
        assert client.get("/api/v1/admin/settings").status_code in (401, 403)
        assert client.get("/api/v1/auth/me").json()["capabilities"] == {"automationTriggers": True}
        monkeypatch.setenv("RELAY_AUTOMATION_TRIGGERS_ENABLED", "0")
        assert client.get("/api/v1/auth/me").json()["capabilities"] == {"automationTriggers": False}


def _legacy_routine(client: TestClient, agent: dict) -> dict:
    return client.app.state.task_store.create_task({
        "title": "Old", "isRoutine": True, "routineCadence": "weekly", "routineType": "task",
        "routineNextRunDate": "2030-01-02", "routineEnabled": True, "routineTrigger": {"kind": "schedule"},
        "assignedAgent": agent["executorKind"], "assignedAgentId": agent["id"], "ownerUserId": ALICE,
        "assigneeUserId": ALICE,
    })


def test_assignment_of_a_legacy_routine_answers_without_legacy_fields(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        legacy = _legacy_routine(client, agent)
        assert set(LEGACY_FIELDS) & set(client.app.state.task_store.get_task(legacy["id"]))
        response = client.put(f"/api/v1/tasks/{legacy['id']}/assignment", json={"agentId": agent["id"]})
        assert response.status_code == 200, response.text
        assert not set(LEGACY_FIELDS) & set(response.json())


def test_rejected_start_of_a_legacy_routine_answers_without_legacy_fields(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        # A legacy executor-kind assignment with no runtime for it: the start
        # is answered while preparing, before any automation path.
        legacy = client.app.state.task_store.create_task({
            "title": "Old", "isRoutine": True, "routineCadence": "weekly", "routineEnabled": True,
            "routineNextRunDate": "2030-01-02", "assignedAgent": "kimi", "ownerUserId": ALICE,
            "assigneeUserId": ALICE,
        })
        response = client.post(f"/api/v1/tasks/{legacy['id']}/runs", json={})
        assert response.status_code == 202, response.text
        body = response.json()
        assert body["dispatch"]["code"] == "agent_offline"
        assert body["task"]["id"] == legacy["id"]
        assert not set(LEGACY_FIELDS) & set(body["task"])


def test_any_resume_resets_failures_but_only_a_relay_resume_resets_the_rate_window(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine = _routine(client, agent)
        store, automations = client.app.state.task_store, client.app.state.automation_store
        window = datetime.now(UTC)
        automations.save_state(routine["id"], {**automations.get_state(routine["id"]),
                                               "consecutive_failures": 3, "fired_count": 2,
                                               "fired_window_start": window})
        store.update_task(routine["id"], {"routineState": "paused_by_relay", "routinePauseReason": "failing",
                                          "routineNextRunAt": None})
        path = f"/api/v1/tasks/{routine['id']}"
        assert client.patch(path, json={"routineState": "paused"}).status_code == 200
        assert automations.get_state(routine["id"])["consecutive_failures"] == 3
        assert client.patch(path, json={"routineState": "active"}).status_code == 200
        state = automations.get_state(routine["id"])
        assert state["consecutive_failures"] == 0
        assert state["fired_count"] == 2
        store.update_task(routine["id"], {"routineState": "paused_by_relay", "routinePauseReason": "failing",
                                          "routineNextRunAt": None})
        assert client.patch(path, json={"routineState": "active"}).status_code == 200
        assert automations.get_state(routine["id"])["fired_count"] == 0


def test_resume_clears_pause_pending_and_recomputes_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task_store, automation_store = client.app.state.task_store, client.app.state.automation_store
        task = _routine(client, agent)
        task_store.update_task(task["id"], {"routineState": "paused_by_relay", "routinePauseReason": "failing",
                                            "routineNextRunAt": None})
        automation_store.mark_pending(task["id"], {"eventType": "manual", "depth": 0}, datetime.now(UTC))
        automation_store.save_state(task["id"], {**automation_store.get_state(task["id"]), "consecutive_failures": 3})
        response = client.post(f"/api/v1/tasks/{task['id']}/automation/resume")
        assert response.status_code == 200, response.text
        resumed = response.json()
        assert resumed["routineState"] == "active" and "routinePauseReason" not in resumed
        assert resumed["routineNextRunAt"].endswith("T09:00:00+00:00")
        assert not set(LEGACY_FIELDS) & set(resumed)
        state = automation_store.get_state(task["id"])
        assert state["pending"] is False and state["consecutive_failures"] == 0


def test_resume_by_non_owner_is_403(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        _create_account(client, "bob", user_id="bob")
        # Bob can see the automation as its assignee, but only its owner or an admin may resume it.
        task = _routine(client, agent)
        client.app.state.task_store.update_task(task["id"], {
            "assigneeUserId": BOB, "routineState": "paused_by_relay", "routinePauseReason": "failing", "routineNextRunAt": None})
        _login(client, "bob")
        response = client.post(f"/api/v1/tasks/{task['id']}/automation/resume")
        assert response.status_code == 403
        assert "owner or an admin" in response.json()["detail"]
        assert client.app.state.task_store.get_task(task["id"])["routineState"] == "paused_by_relay"


@pytest.mark.parametrize("state", ["active", "paused"])
def test_assignee_cannot_lift_relay_pause_via_patch(monkeypatch, state: str) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        _create_account(client, "bob", user_id="bob")
        task = _routine(client, agent)
        store = client.app.state.task_store
        store.update_task(task["id"], {
            "assigneeUserId": BOB, "routineState": "paused_by_relay",
            "routinePauseReason": "failing", "routineNextRunAt": None,
        })
        automations = client.app.state.automation_store
        automations.record_outcome(task["id"], "failure-1", True)
        automations.mark_pending(task["id"], {"eventType": "manual", "depth": 0}, datetime.now(UTC))
        before = store.get_task(task["id"])
        before_state = automations.get_state(task["id"])
        _login(client, "bob")
        response = client.patch(f"/api/v1/tasks/{task['id']}", json={"routineState": state})
        assert response.status_code == 403
        assert "owner or an admin" in response.json()["detail"]
        assert store.get_task(task["id"]) == before
        assert automations.get_state(task["id"]) == before_state


@pytest.mark.parametrize("actor, expected_status", [("bob", 403), ("alice", 200), ("admin", 200)])
def test_only_owner_or_admin_can_convert_a_relay_paused_automation(monkeypatch, actor: str, expected_status: int) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        _create_account(client, "bob", user_id="bob")
        task = _routine(client, agent)
        store = client.app.state.task_store
        store.update_task(task["id"], {
            "assigneeUserId": BOB, "routineState": "paused_by_relay",
            "routinePauseReason": "failing", "routineNextRunAt": None,
        })
        before = store.get_task(task["id"])
        if actor != "admin":
            _login(client, actor)
        response = client.patch(f"/api/v1/tasks/{task['id']}", json={"isRoutine": False})
        assert response.status_code == expected_status, response.text
        if expected_status == 403:
            assert "owner or an admin" in response.json()["detail"]
            assert store.get_task(task["id"]) == before
        else:
            assert response.json()["isRoutine"] is False


@pytest.mark.parametrize("actor", ["alice", "admin"])
def test_owner_or_admin_can_lift_relay_pause_via_patch(monkeypatch, actor: str) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent)
        client.app.state.task_store.update_task(task["id"], {
            "routineState": "paused_by_relay", "routinePauseReason": "failing", "routineNextRunAt": None,
        })
        if actor == "alice":
            _login(client, "alice")
        response = client.patch(f"/api/v1/tasks/{task['id']}", json={"routineState": "active"})
        assert response.status_code == 200, response.text
        assert response.json()["routineState"] == "active"
        assert "routinePauseReason" not in response.json()


def test_assignee_can_edit_relay_pause_and_toggle_an_ordinary_pause(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        _create_account(client, "bob", user_id="bob")
        task = _routine(client, agent)
        store = client.app.state.task_store
        store.update_task(task["id"], {
            "assigneeUserId": BOB, "routineState": "paused_by_relay",
            "routinePauseReason": "failing", "routineNextRunAt": None,
        })
        _login(client, "bob")
        path = f"/api/v1/tasks/{task['id']}"
        response = client.patch(path, json={"title": "Updated"})
        assert response.status_code == 200, response.text
        assert response.json()["routineState"] == "paused_by_relay"
        assert response.json()["routinePauseReason"] == "failing"
        store.update_task(task["id"], {"routineState": "paused", "routinePauseReason": None})
        for state in ("active", "paused"):
            response = client.patch(path, json={"routineState": state})
            assert response.status_code == 200, response.text
            assert response.json()["routineState"] == state


def test_resume_by_owner_succeeds(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent)
        client.app.state.task_store.update_task(task["id"], {
            "routineState": "paused_by_relay", "routinePauseReason": "failing", "routineNextRunAt": None})
        _login(client, "alice")
        response = client.post(f"/api/v1/tasks/{task['id']}/automation/resume")
        assert response.status_code == 200, response.text
        assert response.json()["routineState"] == "active"
        activity = client.app.state.task_store.get_task(task["id"])["activity"]
        assert activity[-1]["message"] == "Automation resumed by its owner."


def test_resume_active_is_noop(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent)
        automation_store = client.app.state.automation_store
        automation_store.save_state(task["id"], {**automation_store.get_state(task["id"]), "consecutive_failures": 2})
        before = client.app.state.task_store.get_task(task["id"])
        response = client.post(f"/api/v1/tasks/{task['id']}/automation/resume")
        assert response.status_code == 200, response.text
        assert response.json()["routineState"] == "active"
        assert response.json()["routineNextRunAt"] == task["routineNextRunAt"]
        assert client.app.state.task_store.get_task(task["id"])["updatedAt"] == before["updatedAt"]
        assert automation_store.get_state(task["id"])["consecutive_failures"] == 2


def test_resume_of_a_plain_task_is_404(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, _ = _client(monkeypatch, root)
        plain = client.post("/api/v1/tasks", json={"title": "plain"}).json()
        assert client.post(f"/api/v1/tasks/{plain['id']}/automation/resume").status_code == 404


def test_patch_resume_of_owner_pause_keeps_the_rate_window(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent, routineTriggers=[])
        automation_store = client.app.state.automation_store
        window = datetime.now(UTC)
        automation_store.save_state(task["id"], {**automation_store.get_state(task["id"]),
                                                 "fired_window_start": window, "fired_count": 4,
                                                 "consecutive_failures": 2})
        path = f"/api/v1/tasks/{task['id']}"
        assert client.patch(path, json={"routineState": "paused"}).status_code == 200
        assert client.post(path + "/automation/resume").json()["routineState"] == "active"
        state = automation_store.get_state(task["id"])
        assert (state["fired_count"], state["consecutive_failures"]) == (4, 0)


PAST_ONCE = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"once": "2000-01-01T09:00"}}}]


def test_active_create_rejects_past_once(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        response = client.post("/api/v1/tasks", json={
            "title": "Missed", "isRoutine": True, "routineState": "active",
            "assignedAgentId": agent["id"], "ownerUserId": ALICE,
            "assigneeUserId": ALICE, "routineTriggers": PAST_ONCE,
        })
        assert response.status_code == 400
        assert "routineTriggers[0]" in response.json()["detail"]
        assert "future" in response.json()["detail"]


@pytest.mark.parametrize("resume", ["patch", "post"])
def test_activation_rejects_past_once_without_mutating_pause(monkeypatch, resume) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent, routineState="paused", routineTriggers=PAST_ONCE)
        path = f"/api/v1/tasks/{task['id']}"
        response = (client.patch(path, json={"routineState": "active"}) if resume == "patch"
                    else client.post(path + "/automation/resume"))
        assert response.status_code == 400
        assert client.app.state.task_store.get_task(task["id"])["routineState"] == "paused"


def test_active_schedule_change_rejects_past_once_even_with_event_trigger(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent)
        response = client.patch(f"/api/v1/tasks/{task['id']}", json={"routineTriggers": [WEBHOOK, *PAST_ONCE]})
        assert response.status_code == 400
        assert "routineTriggers[1]" in response.json()["detail"]
        assert client.app.state.task_store.get_task(task["id"])["routineTriggers"] == DAILY_9


def test_completed_once_remains_editable_and_active_resume_is_noop(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent)
        client.app.state.task_store.update_task(task["id"], {
            "routineTriggers": PAST_ONCE, "routineNextRunAt": None,
        })
        path = f"/api/v1/tasks/{task['id']}"
        response = client.patch(path, json={"title": "Finished", "routineState": "active", "routineTriggers": PAST_ONCE})
        assert response.status_code == 200, response.text
        assert response.json()["title"] == "Finished"
        assert client.post(path + "/automation/resume").status_code == 200


@pytest.mark.parametrize("body, status", [({"routineState": "active"}, 403), ({"isRoutine": False}, 403), ({"routineTriggers": DAILY_9}, 200)])
def test_patch_rechecks_a_relay_pause_after_initial_validation(monkeypatch, body: dict, status: int) -> None:
    from relay.api.tasks import payloads as task_payloads

    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        _create_account(client, "bob", user_id="bob")
        task = _routine(client, agent)
        store = client.app.state.task_store
        store.update_task(task["id"], {"assigneeUserId": BOB})
        _login(client, "bob")
        original = task_payloads.routine_fields
        paused = False

        def racing_fields(payload, *, current=None):
            nonlocal paused
            fields = original(payload, current=current)
            if not paused:
                paused = True
                store.update_task(task["id"], {"routineState": "paused_by_relay", "routinePauseReason": "failing", "routineNextRunAt": None})
            return fields

        monkeypatch.setattr(task_payloads, "routine_fields", racing_fields)
        response = client.patch(f"/api/v1/tasks/{task['id']}", json=body)
        assert response.status_code == status, response.text
        current = store.get_task(task["id"])
        assert current["routineState"] == "paused_by_relay"
        assert current["routinePauseReason"] == "failing"


def test_resume_reads_pause_after_entering_automation_transaction(monkeypatch) -> None:
    from contextlib import contextmanager
    from relay.automations import service

    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        task = _routine(client, agent, routineState="paused")
        store, automations = client.app.state.task_store, client.app.state.automation_store
        automations.save_state(task["id"], {**automations.get_state(task["id"]), "fired_count": 3, "fired_window_start": datetime.now(UTC)})
        original = service.store_transaction

        @contextmanager
        def racing_transaction(engine):
            store.update_task(task["id"], {"routineState": "paused_by_relay", "routinePauseReason": "rate_limited"})
            with original(engine) as conn:
                yield conn

        monkeypatch.setattr(service, "store_transaction", racing_transaction)
        response = client.post(f"/api/v1/tasks/{task['id']}/automation/resume")
        assert response.status_code == 200, response.text
        assert automations.get_state(task["id"])["fired_count"] == 0
