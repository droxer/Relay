import pytest

import test_agent_model_api as model_api
from test_agent_model_api import _register_node, _create_agent, _login_alice


@pytest.fixture
def env(monkeypatch):
    yield from model_api.env.__wrapped__(monkeypatch)


def setup_agents(env):
    app, client = env
    _register_node(app, ["work-results", "round-result", "direct-delegation"])
    a = _create_agent(client, displayName="A")
    b = _create_agent(client, displayName="B")
    _login_alice(client)
    return app, client, a, b


def complete(app, command, work, *, failed=False):
    event = {"type": "run.failed" if failed else "run.completed", "commandId": command["id"],
             "runId": command["runId"], "sessionId": command["sessionId"], "agent": "codex",
             "exitCode": 1 if failed else 0, "agentLog": work.get("note", "Work returned")}
    if failed:
        event["error"] = "B's runtime failed"
    else:
        event["roundResult"] = {"status": work["status"], "work": work}
    app.state.registry.handle_event("node_a", event, "node_token")


def test_owner_configures_allowed_targets(env):
    app, client, a, b = setup_agents(env)
    response = client.patch(f"/api/v1/agents/{a['id']}", json={"delegationAgentIds": [b["id"]]})
    assert response.status_code == 200, response.text
    assert response.json()["agent"]["delegationAgentIds"] == [b["id"]]
    for ids in ([a["id"]], ["missing"], "any", [b["id"]] * 21):
        assert client.patch(f"/api/v1/agents/{a['id']}", json={"delegationAgentIds": ids}).status_code == 400


def test_foreign_and_cross_computer_grants_are_rejected(env):
    app, client, a, b = setup_agents(env)
    other_user = next(user for user in app.state.auth_store.list_users() if user["id"] != a["supervisorUserId"])
    foreign = app.state.agent_store.create_agent(other_user["id"], {"displayName": "Foreign", "executorKind": "codex",
        "defaultRole": "implementer", "computerId": a["computerId"]})
    other_computer = app.state.agent_store.create_agent(a["supervisorUserId"], {"displayName": "Elsewhere", "executorKind": "codex",
        "defaultRole": "implementer", "computerId": "different-computer"})
    for target in (foreign, other_computer):
        response = client.patch(f"/api/v1/agents/{a['id']}", json={"delegationAgentIds": [target["id"]]})
        assert response.status_code == 400, response.text
    assert client.patch(f"/api/v1/agents/{foreign['id']}", json={"delegationAgentIds": []}).status_code == 403


@pytest.mark.parametrize("child_outcome", ["done", "blocked", "failed"])
def test_direct_delegation_runs_b_then_resumes_a_in_same_thread(env, child_outcome):
    app, client, a, b = setup_agents(env)
    permitted = client.patch(f"/api/v1/agents/{a['id']}", json={"delegationAgentIds": [b["id"]]})
    assert permitted.status_code == 200, permitted.text
    started = client.post("/api/v1/agent-runs", json={"taskGoal": "Build sign-in", "assignments": [{"agentId": a["id"]}]})
    assert started.status_code == 202, started.text
    [first] = app.state.registry.take_commands("node_a", "node_token")
    assert first["state"]["delegation_candidates"][0]["agentId"] == b["id"]
    work = {"status": "continue", "delegation": {"agentId": b["id"], "objective": "Write sign-in tests",
            "context": "Use existing fixtures", "acceptanceCriteria": ["Expiry covered"], "expectedOutputs": ["tests"]}}
    complete(app, first, work)
    [child] = app.state.registry.take_commands("node_a", "node_token")
    assert child["sessionId"] == first["sessionId"]
    assert child["state"]["agent_display_name"] == "B"
    assert not child["state"].get("delegation_candidates")
    complete(app, child, {"status": "blocked" if child_outcome != "done" else "done",
                         "note": "Returned result", "evidence": ["pytest passed"]}, failed=child_outcome == "failed")
    [resumed] = app.state.registry.take_commands("node_a", "node_token")
    assert resumed["sessionId"] == first["sessionId"]
    assert resumed["state"]["agent_display_name"] == "A"
    assert "Returned result" in str(resumed["state"]) or child_outcome == "failed"
    complete(app, resumed, {"status": "done", "evidence": ["Checked B's changes and tests"]})
    session = app.state.session_store.get_session(first["sessionId"])
    assert session["status"] == "completed"
    assert [run["logicalAgentId"] for run in session["agentRuns"]] == [a["id"], b["id"], a["id"]]
    assert any(round_.get("source") == "direct_delegation" for round_ in session["collaborationRounds"])


def test_agent_cannot_delegate_to_unapproved_target(env):
    app, client, a, b = setup_agents(env)
    assert client.patch(f"/api/v1/agents/{a['id']}", json={"delegationAgentIds": []}).status_code == 200
    client.post("/api/v1/agent-runs", json={"taskGoal": "Build", "assignments": [{"agentId": a["id"]}]})
    [first] = app.state.registry.take_commands("node_a", "node_token")
    complete(app, first, {"status": "continue", "delegation": {"agentId": b["id"], "objective": "Write tests",
        "acceptanceCriteria": ["pass"], "expectedOutputs": ["tests"]}})
    [resumed] = app.state.registry.take_commands("node_a", "node_token")
    assert resumed["state"]["agent_display_name"] == "A"
    assert "refused" in resumed["state"]["delegation_return"].lower()
    assert not any(run["logicalAgentId"] == b["id"] for run in app.state.session_store.get_session(first["sessionId"])["agentRuns"])


def test_all_eligible_agents_are_delegation_targets_by_default(env):
    app, client, a, b = setup_agents(env)
    response = client.post("/api/v1/agent-runs", json={"taskGoal": "Build", "assignments": [{"agentId": a["id"]}]})
    assert response.status_code == 202, response.text
    [first] = app.state.registry.take_commands("node_a", "node_token")
    assert b["id"] in {candidate["agentId"] for candidate in first["state"]["delegation_candidates"]}
    complete(app, first, {"status": "continue", "delegation": {"agentId": b["id"], "objective": "Write tests",
        "acceptanceCriteria": ["pass"], "expectedOutputs": ["tests"]}})
    [child] = app.state.registry.take_commands("node_a", "node_token")
    assert child["state"]["agent_display_name"] == "B"


def test_resetting_to_all_includes_agents_created_later(env):
    app, client, a, b = setup_agents(env)
    assert client.patch(f"/api/v1/agents/{a['id']}", json={"delegationAgentIds": []}).status_code == 200
    reset = client.patch(f"/api/v1/agents/{a['id']}", json={"delegationAgentIds": None})
    assert reset.status_code == 200, reset.text
    created = client.post("/api/v1/agents", json={"computerId": a["computerId"], "executorKind": "codex",
        "defaultRole": "implementer", "displayName": "C"})
    assert created.status_code == 201, created.text
    c = created.json()["agent"]
    response = client.post("/api/v1/agent-runs", json={"taskGoal": "Build", "assignments": [{"agentId": a["id"]}]})
    assert response.status_code == 202, response.text
    [first] = app.state.registry.take_commands("node_a", "node_token")
    ids = {candidate["agentId"] for candidate in first["state"]["delegation_candidates"]}
    assert ids == {b["id"], c["id"]}


def begin_delegation(env):
    app, client, a, b = setup_agents(env)
    assert client.patch(f"/api/v1/agents/{a['id']}", json={"delegationAgentIds": [b["id"]]}).status_code == 200
    response = client.post("/api/v1/agent-runs", json={"taskGoal": "Build", "assignments": [{"agentId": a["id"]}]})
    assert response.status_code == 202, response.text
    [first] = app.state.registry.take_commands("node_a", "node_token")
    work = {"status": "continue", "delegation": {"agentId": b["id"], "objective": "Write tests",
            "acceptanceCriteria": ["pass"], "expectedOutputs": ["tests"]}}
    return app, client, a, b, first, work


def test_permission_revoked_before_request_is_applied_never_runs_b(env):
    app, client, a, b, first, work = begin_delegation(env)
    assert client.patch(f"/api/v1/agents/{a['id']}", json={"delegationAgentIds": []}).status_code == 200
    complete(app, first, work)
    [resumed] = app.state.registry.take_commands("node_a", "node_token")
    assert resumed["state"]["agent_display_name"] == "A"
    assert not resumed["state"].get("delegation_candidates")


def test_nested_delegation_returns_to_a_without_dispatching_another_agent(env):
    app, client, a, b, first, work = begin_delegation(env)
    complete(app, first, work)
    [child] = app.state.registry.take_commands("node_a", "node_token")
    complete(app, child, {**work, "delegation": {**work["delegation"], "agentId": a["id"]}})
    [resumed] = app.state.registry.take_commands("node_a", "node_token")
    assert resumed["state"]["agent_display_name"] == "A"


def test_stop_during_delegation_fences_a_late_child_result(env):
    app, client, a, b, first, work = begin_delegation(env)
    complete(app, first, work)
    [child] = app.state.registry.take_commands("node_a", "node_token")
    response = client.post(f"/api/v1/threads/{first['sessionId']}/decisions", json={"kind": "cancel"})
    assert response.status_code == 200, response.text
    complete(app, child, {"status": "done", "evidence": ["Tests passed"]})
    commands = app.state.registry.take_commands("node_a", "node_token")
    assert not any(command["type"] == "run.start" for command in commands)
    assert app.state.session_store.get_session(first["sessionId"])["status"] == "cancelled"


def test_manifest_replay_after_a_crash_dispatches_one_child(env, monkeypatch):
    app, client, a, b, first, work = begin_delegation(env)
    store = app.state.daemon_store
    original = store.update_run_request_if_claimed
    crashed = False

    def crash_before_cursor(*args, **kwargs):
        nonlocal crashed
        patch = args[3]
        if len(patch.get("assignments", [])) == 3 and not crashed:
            crashed = True
            raise RuntimeError("Crash after manifest was recorded")
        return original(*args, **kwargs)

    monkeypatch.setattr(store, "update_run_request_if_claimed", crash_before_cursor)
    with pytest.raises(RuntimeError, match="Crash after manifest"):
        complete(app, first, work)
    request = store.run_request_for_command(first["id"])
    store.update_run_request(request["id"], {"state": {**request["state"],
        "_relay_finalization_retry_at": "2000-01-01T00:00:00+00:00",
        "_relay_terminal_claim_expires_at": "2000-01-01T00:00:00+00:00"}})
    app.state.registry.reap_stale_runs()
    [child] = app.state.registry.take_commands("node_a", "node_token")
    assert child["state"]["agent_display_name"] == "B"
    session = app.state.session_store.get_session(first["sessionId"])
    assert len([round_ for round_ in session["collaborationRounds"] if round_["source"] == "direct_delegation"]) == 1


def test_target_becoming_unavailable_before_delivery_returns_to_a(env):
    app, client, a, b, first, work = begin_delegation(env)
    original = app.state.registry.logical_assignment_validator
    checks = 0

    def unavailable_at_delivery(assignment):
        nonlocal checks
        if assignment.get("delegatedByAgentId"):
            checks += 1
            if checks > 1:
                raise ValueError("Delegate is no longer available")
        original(assignment)

    app.state.registry.logical_assignment_validator = unavailable_at_delivery
    complete(app, first, work)
    [resumed] = app.state.registry.take_commands("node_a", "node_token")
    assert resumed["state"]["agent_display_name"] == "A"
    assert "no longer available" in str(resumed["state"]["work_predecessor_results"])
