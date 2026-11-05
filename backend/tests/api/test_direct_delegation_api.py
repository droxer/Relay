import pytest

import test_agent_model_api as model_api
from test_agent_model_api import _register_node, _create_agent, _login_alice


@pytest.fixture
def env(monkeypatch):
    yield from model_api.env.__wrapped__(monkeypatch)


def setup_agents(env):
    app, client = env
    _register_node(app, ["work-results", "round-result"])
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
    client.post("/api/v1/agent-runs", json={"taskGoal": "Build", "assignments": [{"agentId": a["id"]}]})
    [first] = app.state.registry.take_commands("node_a", "node_token")
    complete(app, first, {"status": "continue", "delegation": {"agentId": b["id"], "objective": "Write tests",
        "acceptanceCriteria": ["pass"], "expectedOutputs": ["tests"]}})
    assert app.state.registry.take_commands("node_a", "node_token") == []
    assert not any(run["logicalAgentId"] == b["id"] for run in app.state.session_store.get_session(first["sessionId"])["agentRuns"])
