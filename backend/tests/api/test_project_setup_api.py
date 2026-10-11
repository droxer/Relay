from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

from test_project_routes import _agent, _bootstrap, _login_alice


def _register(app, node_id: str, *, setup: bool = True) -> dict:
    return app.state.registry.register(
        {
            "sandboxId": node_id,
            "employeeId": "alice",
            "token": f"token_{node_id}",
            "protocolVersion": 1,
            "supportedAgents": ["codex", "claude"],
            "capabilities": [
                "thread-workspaces",
                "project-workspaces",
                *(["project-setup"] if setup else []),
            ],
            "status": "ready",
            "workspacePath": "/workspace/relay",
            "workspaceId": f"{node_id}-machine",
        }
    )


@pytest.fixture
def setup_env(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register(app, "node_alice_setup")
    planner = _agent(client, app, node, "Planner", "codex")
    builder = _agent(client, app, node, "Builder", "claude")
    _login_alice(client)
    project = client.post("/api/v1/projects", json={
        "name": "Launch the marketing site", "daemonNodeId": node["id"], "members": [],
    }).json()["project"]
    return app, client, node, project, planner, builder


def _take_command(app, node) -> dict:
    [command] = TestClient(app).get(
        f"/api/v1/daemon-nodes/{node['id']}/commands?leaseMode=explicit&leaseSeconds=10",
        headers={"Authorization": f"Bearer token_{node['id']}"},
    ).json()["commands"]
    return command


def _complete(app, node, command, thread_id, *, proposal=None, exit_code=0):
    response = TestClient(app).post(
        f"/api/v1/daemon-nodes/{node['id']}/events",
        json={
            "type": "run.completed",
            "commandId": command["id"],
            "leaseId": command["leaseId"],
            "sessionId": thread_id,
            "runId": command["runId"],
            "agent": command["agent"],
            "exitCode": exit_code,
            "agentLog": "Drafted the setup.",
            **({"projectSetup": proposal} if proposal is not None else {}),
        },
        headers={"Authorization": f"Bearer token_{node['id']}"},
    )
    assert response.status_code == 200, response.text


def _proposal(planner, builder) -> dict:
    return {
        "name": "Spring site launch",
        "goal": "Launch the marketing site by March 14",
        "context": "Use Next.js. Lighthouse above 90.",
        "leadAgentId": planner["id"],
        "members": [
            {"agentId": planner["id"], "role": "planner", "responsibilities": "Own the launch plan"},
            {"agentId": builder["id"], "role": "wizard", "responsibilities": "Build the pages"},
            {"agentId": "agent-from-nowhere", "role": "tester", "responsibilities": "Test"},
        ],
        "tasks": [{"title": "Draft the sitemap", "acceptanceCriteria": ["Every page listed"]}],
    }


def test_setup_drafts_a_proposal_the_owner_applies(setup_env):
    app, client, node, project, planner, builder = setup_env

    started = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Launch our marketing site with a pricing page", "agentId": planner["id"],
    })
    assert started.status_code == 202, started.text
    thread_id = started.json()["threadId"]
    assert started.json()["project"]["setup"]["state"] == "drafting"
    assert started.json()["project"]["setup"]["agentId"] == planner["id"]

    command = _take_command(app, node)
    setup_state = command["state"]["project_setup"]
    assert setup_state["file"] == f".relay/project-setup-{command['runId']}.json"
    assert setup_state["intent"] == "Launch our marketing site with a pricing page"
    assert {c["agentId"] for c in setup_state["candidates"]} == {planner["id"], builder["id"]}
    assert command["workspaceSubpath"] == project["workspaceSubpath"]

    _complete(app, node, command, thread_id, proposal=_proposal(planner, builder))

    setup = client.get(f"/api/v1/projects/{project['id']}/setup").json()["setup"]
    assert setup["state"] == "proposed"
    members = {m["agentId"]: m for m in setup["proposal"]["members"]}
    assert members[builder["id"]]["role"] == "implementer", "an unknown role is normalized"
    assert members["agent-from-nowhere"]["issue"] == "agent_not_found"
    assert "issue" not in members[planner["id"]]
    assert "Every page listed" in setup["proposal"]["tasks"][0]["description"]

    latest = client.get(f"/api/v1/projects/{project['id']}").json()["project"]
    applied = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": latest["version"],
        "name": setup["proposal"]["name"],
        "goal": setup["proposal"]["goal"],
        "context": setup["proposal"]["context"],
        "leadAgentId": planner["id"],
        "members": [
            {k: v for k, v in member.items() if k != "issue"}
            for member in setup["proposal"]["members"] if "issue" not in member
        ],
        "setupResolution": "applied",
    })
    assert applied.status_code == 200, applied.text
    record = applied.json()["project"]
    assert record["setup"]["state"] == "applied"
    assert record["name"] == "Spring site launch"
    assert [m["agentId"] for m in record["members"]] == [planner["id"], builder["id"]]


def test_a_run_without_a_proposal_marks_the_setup_failed(setup_env):
    app, client, node, project, _, _ = setup_env
    thread_id = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Something vague",
    }).json()["threadId"]

    _complete(app, node, _take_command(app, node), thread_id)

    setup = client.get(f"/api/v1/projects/{project['id']}").json()["project"]["setup"]
    assert setup["state"] == "failed"
    assert setup["error"] == "setup_no_proposal"
    retried = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Try again"})
    assert retried.status_code == 202, retried.text


def test_revise_drafts_again_in_the_same_thread(setup_env):
    app, client, node, project, planner, builder = setup_env
    thread_id = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Launch the site",
    }).json()["threadId"]
    _complete(app, node, _take_command(app, node), thread_id, proposal=_proposal(planner, builder))

    revised = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Drop the builder; the planner can do it alone.", "revise": True,
    })
    assert revised.status_code == 202, revised.text
    assert revised.json()["threadId"] == thread_id
    command = _take_command(app, node)
    assert command["state"]["project_setup"]["previousProposal"]["name"] == "Spring site launch"


def test_a_setup_in_progress_refuses_a_second_draft(setup_env):
    _, client, _, project, _, _ = setup_env
    assert client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "One"}).status_code == 202
    second = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Two"})
    assert second.status_code == 409
    assert second.json()["detail"] == "project_setup_in_progress"


def test_setup_needs_a_daemon_that_reports_proposals(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    _bootstrap(client)
    node = _register(app, "node_alice_old", setup=False)
    _agent(client, app, node, "Planner", "codex")
    _login_alice(client)
    project = client.post("/api/v1/projects", json={
        "name": "Old daemon", "daemonNodeId": node["id"], "members": [],
    }).json()["project"]

    response = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Go"})

    assert response.status_code == 409
    assert response.json()["detail"] == "project_setup_unsupported"
    assert client.get(f"/api/v1/projects/{project['id']}").json()["project"].get("setup") is None


def test_setup_cannot_be_applied_before_it_is_proposed(setup_env):
    _, client, _, project, _, _ = setup_env
    started = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Go"}).json()

    response = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": started["project"]["version"], "setupResolution": "applied",
    })

    assert response.status_code == 400
    assert response.json()["detail"] == "project_setup_not_proposed"


def test_a_revise_that_cannot_dispatch_restores_the_proposal(setup_env, monkeypatch):
    from relay.collaboration.service import CollaborationConductor, CollaborationError

    app, client, node, project, planner, builder = setup_env
    thread_id = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Launch", "agentId": planner["id"],
    }).json()["threadId"]
    _complete(app, node, _take_command(app, node), thread_id, proposal=_proposal(planner, builder))

    async def refuse(self, intent, actor):
        raise CollaborationError("workspace_busy")

    monkeypatch.setattr(CollaborationConductor, "submit", refuse)
    revised = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Smaller", "revise": True})

    assert revised.status_code == 409
    setup = client.get(f"/api/v1/projects/{project['id']}").json()["project"]["setup"]
    assert setup["state"] == "proposed"
    assert setup["proposal"]["name"] == "Spring site launch"


@pytest.mark.parametrize("replacement", ["dismissed", "new_draft", "new_unbound_draft", "new_revision"])
def test_completion_rechecks_setup_inside_the_project_mutation(setup_env, monkeypatch, replacement):
    app, client, node, project, planner, builder = setup_env
    started = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Launch"}).json()
    command = _take_command(app, node)
    store = app.state.project_store
    mutate = store._mutate
    intervening = {}

    def interleave(project_id, event_type, **kwargs):
        monkeypatch.setattr(store, "_mutate", mutate)
        current = store.get_project(project_id)
        if replacement == "dismissed":
            from relay.services.project_setup import resolved_setup

            intervening.update(store.update_project(
                project_id, {"setup": resolved_setup(current["setup"], "dismissed")},
                expected_version=current["version"],
            ))
        else:
            intervening.update(store.record_setup(project_id, {
                "state": "drafting", "draftId": "replacement-draft",
                "threadId": None if replacement == "new_unbound_draft" else (
                    started["threadId"] if replacement == "new_revision" else "another-thread"
                ),
                "startedAt": "later", "intent": "Other work",
            }))
        return mutate(project_id, event_type, **kwargs)

    monkeypatch.setattr(store, "_mutate", interleave)
    _complete(app, node, command, started["threadId"], proposal=_proposal(planner, builder))

    latest = store.get_project(project["id"])
    assert latest["setup"] == intervening["setup"]
    assert latest["version"] == intervening["version"], "a stale completion is a no-op"


def test_failure_before_delivery_closes_the_draft(setup_env):
    app, client, node, project, _, _ = setup_env
    started = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Launch"}).json()
    registry = app.state.registry
    request = registry.daemon_store.active_run_request_for_session_any_node(started["threadId"])

    registry._fail_run_request(request, "Placement unavailable before delivery.")

    latest = app.state.project_store.get_project(project["id"])
    assert app.state.session_store.get_session(started["threadId"])["status"] == "failed"
    assert latest["setup"]["state"] == "failed"
    assert latest["setup"]["error"] == "setup_run_failed"


def test_dispatch_response_does_not_attach_its_thread_to_a_replacement_draft(setup_env, monkeypatch):
    from relay.collaboration.service import CollaborationConductor

    app, client, _, project, _, _ = setup_env
    submit = CollaborationConductor.submit
    replacement = {"state": "drafting", "draftId": "replacement", "threadId": None, "startedAt": "later"}

    async def replace_before_response(self, intent, actor):
        session = await submit(self, intent, actor)
        app.state.project_store.record_setup(project["id"], replacement)
        return session

    monkeypatch.setattr(CollaborationConductor, "submit", replace_before_response)
    response = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Launch"})

    assert response.status_code == 202, response.text
    assert response.json()["project"]["setup"] == replacement


def test_start_rechecks_for_another_draft_at_the_write_boundary(setup_env, monkeypatch):
    from relay.core.ids import now_iso

    app, client, _, project, _, _ = setup_env
    store = app.state.project_store
    mutate = store._mutate
    replacement = {"state": "drafting", "draftId": "other-start", "threadId": None, "startedAt": now_iso()}

    def interleave(project_id, event_type, **kwargs):
        monkeypatch.setattr(store, "_mutate", mutate)
        store.record_setup(project_id, replacement)
        return mutate(project_id, event_type, **kwargs)

    monkeypatch.setattr(store, "_mutate", interleave)
    response = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Launch"})

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "project_setup_in_progress"
    assert store.get_project(project["id"])["setup"] == replacement
