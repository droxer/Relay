from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

from test_project_routes import _agent, _bootstrap, _login_alice
from user_ids import user_id

ALICE = user_id("alice")


def _register(app, node_id: str, *, setup: bool = True) -> dict:
    return app.state.registry.register(
        {
            "sandboxId": node_id,
            "userId": ALICE,
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
    assert client.get(f"/api/v1/projects/{project['id']}").json()["project"]["name"] == "Spring site launch"
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
    tasks = client.get("/api/v1/tasks").json()["tasks"]
    assert len(tasks) == 2
    assert all(thread_id in task["linkedSessionIds"] for task in tasks)
    assert revised.json()["project"]["setup"]["taskId"] in {task["id"] for task in tasks}


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
    from relay.collaboration.errors import CollaborationError
    from relay.collaboration.service import CollaborationConductor

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
    tasks = client.get("/api/v1/tasks").json()["tasks"]
    assert [task["id"] for task in tasks] == [setup["taskId"]], "the undispatched task is discarded"


def test_an_unexpected_dispatch_error_discards_the_task_and_fails_the_draft(setup_env, monkeypatch):
    from relay.collaboration.service import CollaborationConductor

    _app, client, _node, project, planner, _builder = setup_env

    async def explode(self, intent, actor):
        raise RuntimeError("database went away")

    monkeypatch.setattr(CollaborationConductor, "submit", explode)
    with pytest.raises(RuntimeError):
        client.post(f"/api/v1/projects/{project['id']}/setup", json={
            "intent": "Launch", "agentId": planner["id"],
        })

    setup = client.get(f"/api/v1/projects/{project['id']}").json()["project"]["setup"]
    assert (setup["state"], setup["error"]) == ("failed", "project_setup_dispatch_failed")
    assert client.get("/api/v1/tasks").json()["tasks"] == []


@pytest.mark.parametrize("resolution", ["applied", "dismissed"])
def test_resolving_a_proposal_closes_its_drafting_task(setup_env, resolution):
    app, client, node, project, planner, builder = setup_env
    thread_id = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Launch", "agentId": planner["id"],
    }).json()["threadId"]
    _complete(app, node, _take_command(app, node), thread_id, proposal=_proposal(planner, builder))
    latest = client.get(f"/api/v1/projects/{project['id']}").json()["project"]
    assert app.state.task_store.get_task(latest["setup"]["taskId"])["status"] == "review"

    resolved = client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": latest["version"], "setupResolution": resolution,
    })

    assert resolved.status_code == 200, resolved.text
    assert app.state.task_store.get_task(latest["setup"]["taskId"])["status"] == "done"


def test_a_revision_closes_the_task_of_the_draft_it_replaces(setup_env):
    app, client, node, project, planner, builder = setup_env
    thread_id = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Launch", "agentId": planner["id"],
    }).json()["threadId"]
    _complete(app, node, _take_command(app, node), thread_id, proposal=_proposal(planner, builder))
    first_task_id = client.get(f"/api/v1/projects/{project['id']}").json()["project"]["setup"]["taskId"]

    revised = client.post(f"/api/v1/projects/{project['id']}/setup", json={"intent": "Smaller", "revise": True})

    assert revised.status_code == 202, revised.text
    assert app.state.task_store.get_task(first_task_id)["status"] == "done"
    assert revised.json()["project"]["setup"]["taskId"] != first_task_id


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
            from relay.projects.setup import resolved_setup

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
    assert client.get("/api/v1/tasks").json()["tasks"] == []


def test_drafting_has_a_task_before_the_thread_starts(setup_env):
    app, client, node, project, planner, builder = setup_env
    started = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Launch the site", "agentId": planner["id"],
    }).json()
    tasks = client.get("/api/v1/tasks").json()["tasks"]
    assert len(tasks) == 1
    task = tasks[0]
    assert task["projectId"] == project["id"]
    assert task["assignedAgentId"] == planner["id"]
    assert started["threadId"] in task["linkedSessionIds"]
    command = _take_command(app, node)
    request = app.state.registry.daemon_store.active_run_request_for_session_any_node(started["threadId"])
    assert request["taskId"] == task["id"]
    manifest = request["state"]["_relay_collaboration_manifest"]
    assert manifest["workScope"] == {"kind": "task", "taskId": task["id"]}
    _complete(app, node, command, started["threadId"], proposal=_proposal(planner, builder))
    assert client.get(f"/api/v1/projects/{project['id']}/setup").json()["setup"]["state"] == "proposed"


@pytest.mark.parametrize("scenario", ["owner_renamed", "name_taken", "missing_name"])
def test_generated_name_preserves_owner_edits_and_name_uniqueness(setup_env, scenario):
    app, client, node, project, planner, builder = setup_env
    started = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Launch the site", "agentId": planner["id"],
    }).json()
    expected_name = project["name"]
    if scenario == "owner_renamed":
        expected_name = "My chosen name"
        renamed = client.patch(f"/api/v1/projects/{project['id']}", json={
            "expectedVersion": started["project"]["version"], "name": expected_name,
        })
        assert renamed.status_code == 200, renamed.text
    if scenario == "name_taken":
        other = client.post("/api/v1/projects", json={
            "name": "Spring site launch", "daemonNodeId": node["id"], "members": [],
        })
        assert other.status_code == 201, other.text
    proposal = _proposal(planner, builder)
    if scenario == "missing_name":
        proposal.pop("name")
    _complete(app, node, _take_command(app, node), started["threadId"], proposal=proposal)
    latest = client.get(f"/api/v1/projects/{project['id']}").json()["project"]
    assert latest["name"] == expected_name
    assert latest["setup"]["state"] == "proposed"


def _assert_draft_owns_its_task(app, client, project_id, thread_id):
    """The draft, its run, and its thread all name one task in the project."""
    setup = client.get(f"/api/v1/projects/{project_id}").json()["project"]["setup"]
    task = app.state.task_store.get_task(setup["taskId"])
    assert task["projectId"] == project_id
    assert not task.get("deletedAt")
    assert thread_id in task["linkedSessionIds"]
    request = app.state.registry.daemon_store.active_run_request_for_session_any_node(thread_id)
    assert request["taskId"] == task["id"]
    assert request["state"]["_relay_collaboration_manifest"]["workScope"] == {"kind": "task", "taskId": task["id"]}
    return task


def test_every_kind_of_draft_runs_under_its_own_task(setup_env):
    from tests.api.test_project_plan_api import _crewed

    app, client, node, project, planner, builder = setup_env
    url = f"/api/v1/projects/{project['id']}/setup"

    # A first draft.
    thread_id = client.post(url, json={"intent": "Launch", "agentId": planner["id"]}).json()["threadId"]
    first = _assert_draft_owns_its_task(app, client, project["id"], thread_id)
    _complete(app, node, _take_command(app, node), thread_id, exit_code=1)
    failed = client.get(url).json()["setup"]
    assert (failed["state"], failed["taskId"]) == ("failed", first["id"]), "a failed run keeps its task"

    # A retry after a failed run starts a new task and settles the old one.
    thread_id = client.post(url, json={"intent": "Launch", "agentId": planner["id"]}).json()["threadId"]
    retried = _assert_draft_owns_its_task(app, client, project["id"], thread_id)
    assert retried["id"] != first["id"]
    assert app.state.task_store.get_task(first["id"])["status"] == "done"
    _complete(app, node, _take_command(app, node), thread_id, proposal=_proposal(planner, builder))
    assert client.get(url).json()["setup"]["taskId"] == retried["id"], "a proposal keeps its task"

    # A revision runs in the same thread under a new task.
    revised = client.post(url, json={"intent": "Smaller", "revise": True}).json()
    assert revised["threadId"] == thread_id
    revision = _assert_draft_owns_its_task(app, client, project["id"], thread_id)
    assert revision["id"] != retried["id"]
    _complete(app, node, _take_command(app, node), thread_id, proposal=_proposal(planner, builder))
    latest = client.get(f"/api/v1/projects/{project['id']}").json()["project"]
    client.patch(f"/api/v1/projects/{project['id']}", json={
        "expectedVersion": latest["version"], "setupResolution": "dismissed",
    })

    # A plan draft.
    _crewed(client, project, planner, builder)
    planned = client.post(url, json={"intent": "Plan the next work", "mode": "plan"})
    assert planned.status_code == 202, planned.text
    plan_task = _assert_draft_owns_its_task(app, client, project["id"], planned.json()["threadId"])
    assert plan_task["assignedAgentId"] == planner["id"], "the lead drafts the plan"


def test_a_draft_that_never_dispatched_names_no_deleted_task(setup_env, monkeypatch):
    from relay.collaboration.errors import CollaborationError
    from relay.collaboration.service import CollaborationConductor

    _app, client, _node, project, planner, _builder = setup_env

    async def refuse(self, intent, actor):
        raise CollaborationError("workspace_busy")

    monkeypatch.setattr(CollaborationConductor, "submit", refuse)
    refused = client.post(f"/api/v1/projects/{project['id']}/setup", json={
        "intent": "Launch", "agentId": planner["id"],
    })

    assert refused.status_code == 409
    setup = client.get(f"/api/v1/projects/{project['id']}").json()["project"]["setup"]
    assert setup["state"] == "failed"
    assert "taskId" not in setup
    assert client.get("/api/v1/tasks").json()["tasks"] == []
