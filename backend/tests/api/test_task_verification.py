import pytest

from test_task_workflows import take
from test_unified_workflows import unified_world
from test_workflow_progression import finish


CHECK = {"commit": "a" * 40, "path": "tests/acceptance.sh"}


@pytest.mark.parametrize("outcome", [
    "passing_repair", "accept_task", "accept_thread", "exhausted", "infrastructure", "agent_claim_only",
])
def test_required_check_owns_the_repair_and_acceptance_gate(monkeypatch, outcome):
    with unified_world(monkeypatch) as (app, client, node, _, project, payload):
        registry = app.state.registry
        registry.register({**node, "protocolVersion": 1, "sandboxId": node["id"], "token": "token_node_here",
                           "sandboxMode": "boxlite", "supportedAgents": ["codex", "claude"],
                           "capabilities": [*node["capabilities"], "work-results", "task-verification"]})
        for agent_id, role in zip(payload["memberAgentIds"], ["implementer", "reviewer"], strict=True):
            response = client.patch(f"/api/v1/agents/{agent_id}", json={"defaultRole": role})
            assert response.status_code == 200, response.text
        fields = {"title": "Fix the export", "projectId": project["id"],
                  "assignedWorkflowId": "preset:build_review", "verificationCheck": CHECK}
        assert client.post("/api/v1/tasks", json={**fields, "acceptancePolicy": "automatic"}).status_code == 409
        created = client.post("/api/v1/tasks", json=fields)
        assert created.status_code == 201, created.text
        assert created.json()["verificationCheck"] == CHECK
        task_path = f"/api/v1/tasks/{created.json()['id']}"
        started = client.post(task_path + "/runs", json={})
        assert started.status_code == 202, started.text
        session_id = started.json()["session"]["id"]
        decision_path = f"/api/v1/threads/{session_id}/decisions"

        statuses = {"passing_repair": ["failed", "passed"], "exhausted": ["failed"] * 3,
                    "infrastructure": ["error"], "agent_claim_only": ["error"]}.get(outcome, ["passed"])
        for index, status in enumerate(statuses):
            builder, = take(registry, node)
            assert "verificationCheck" not in builder
            assert "Commit all intended deliverables" in builder["taskGoal"]
            if index:
                assert "Required check failed" in builder["state"]["repair_note"]
            finish(registry, node, builder, {})
            reviewer, = take(registry, node)
            assert reviewer["verificationCheck"] == CHECK
            result = {"check": CHECK, "status": status, "candidateCommit": str(index + 1) * 40, "output": status}
            if outcome == "agent_claim_only":
                claim = {**result, "status": "passed"}
                event = finish(registry, node, reviewer, {}, roundResult={
                    "status": "done", "work": {"status": "done", "evidence": ["I ran the check"],
                                                 "verificationResult": claim},
                })
                result = {"check": CHECK, "status": "error", "candidateCommit": None,
                          "output": "The Daemon Node did not report a valid verification result."}
            else:
                event = finish(registry, node, reviewer, {}, verificationResult=result)
            registry.handle_event(node["id"], event, "token_node_here")

        assert take(registry, node) == []
        review = client.get(task_path + "/review").json()
        assert len(review["reports"]) == 2
        session = app.state.session_store.get_session(session_id)
        assert sum("verificationResult" in item for item in session["agentRuns"]) == len(statuses)
        assert review["verificationResult"] == {
            **result, "verificationCheckRevision": created.json()["verificationCheckRevision"],
        }
        assert review["canAccept"] is (status == "passed")
        assert review["status"] == ("review" if status == "passed" else "waiting_for_human")
        assert client.patch(task_path, json={"status": "done"}).json()["detail"] == "task_verification_review_required"
        assert client.post(decision_path, json={"kind": "mark_done"}).json()["detail"] == "task_verification_review_required"
        patch = {"status": "done", "reviewRevision": review["revision"]}
        if status != "passed":
            assert client.patch(task_path, json=patch).json()["detail"] == "task_verification_pass_required"
            assert client.post(decision_path, json={"kind": "mark_done", "reviewRevision": review["revision"]}).status_code == 409
            return

        if outcome in ("accept_task", "accept_thread"):
            response = (client.patch(task_path, json=patch) if outcome == "accept_task" else
                        client.post(decision_path, json={"kind": "mark_done", "reviewRevision": review["revision"]}))
            assert response.status_code == 200, response.text
            assert client.get(task_path).json()["status"] == "done"
            return

        replacement = {**CHECK, "commit": "b" * 40}
        assert client.patch(task_path, json={"verificationCheck": replacement}).json()["verificationCheck"] == replacement
        assert client.get(task_path + "/review").json()["verification"] == "pending"
        assert client.patch(task_path, json=patch).json()["detail"] == "task_review_changed"
        assert client.post(decision_path, json={"kind": "mark_done", "reviewRevision": review["revision"]}).status_code == 409
        assert client.patch(task_path, json={"verificationCheck": CHECK}).status_code == 200
        restored = client.get(task_path + "/review").json()
        assert restored["verification"] == "pending" and not restored["canAccept"]
        assert client.patch(task_path, json={"status": "done", "reviewRevision": restored["revision"]}).status_code == 409
