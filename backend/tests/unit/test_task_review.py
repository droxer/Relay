"""A review distinguishes recorded execution facts from an agent's claims."""

from copy import deepcopy

from relay.tasks.review import build_review_brief


def records():
    task = {"id": "task", "title": "Fix export", "description": "Keep CSV columns stable",
            "status": "review", "updatedAt": "now", "linkedSessionIds": ["thread"]}
    manifest = {"roundId": "round", "workScope": {"kind": "task", "taskId": "task"},
                "assignments": [{"assignmentId": "build", "agentId": "agent"}],
                "workGraph": {"items": [{"assignmentId": "build", "acceptanceCriteria": ["CSV stays compatible"]}]}}
    session = {"id": "thread", "activeRoundId": "round", "collaborationRounds": [manifest],
               "agentRuns": [{"id": "run", "assignmentId": "build", "agent": "codex", "logicalAgentId": "agent",
                              "status": "completed", "exitCode": 0, "completedAt": "then",
                              "workResult": {"status": "done", "note": "Fixed CSV escaping", "evidence": ["All tests passed"], "findings": []}}],
               "artifacts": [{"id": "file-v1", "kind": "workspace_file", "title": "export.csv", "agentRunId": "run", "createdAt": "then"}]}
    return task, session


def test_review_keeps_claims_separate_from_recorded_execution():
    task, session = records()
    before = deepcopy(session)
    brief = build_review_brief(task, session)
    assert brief["goal"] == "Fix export"
    assert brief["criteria"] == ["CSV stays compatible"]
    assert brief["reports"][0]["evidence"] == ["All tests passed"]
    assert brief["reports"][0]["exitCode"] == 0
    assert brief["reports"][0]["note"] == "Fixed CSV escaping"
    assert brief["artifacts"][0]["id"] == "file-v1"
    assert brief["verification"] == "not_recorded"
    assert session == before


def test_empty_legacy_review_is_explicit_and_cannot_invent_evidence():
    task, _ = records()
    brief = build_review_brief(task, None)
    assert brief["reports"] == []
    assert brief["artifacts"] == []
    assert brief["roundId"] is None
    assert brief["criteria"] == []
    assert brief["verification"] == "not_recorded"
    assert brief["missing"] == ["thread", "criteria", "reports", "artifacts", "verification"]


def test_review_excludes_other_rounds_and_uses_latest_repair():
    task, session = records()
    session["agentRuns"].insert(0, {"id": "old", "assignmentId": "old-assignment", "agent": "claude", "status": "failed"})
    session["agentRuns"].insert(1, {**session["agentRuns"][-1], "id": "failed-attempt", "status": "failed"})
    session["artifacts"].append({"id": "old-file", "kind": "workspace_file", "agentRunId": "old"})
    session["collaborationRounds"].append({"roundId": "unrelated", "workScope": {"kind": "thread"}, "assignments": []})
    brief = build_review_brief(task, session)
    assert brief["roundId"] == "round"
    assert [run["runId"] for run in brief["reports"]] == ["run"]
    assert [item["id"] for item in brief["artifacts"]] == ["file-v1"]


def test_revision_changes_with_requirements_round_evidence_or_artifact_version():
    task, session = records()
    revision = build_review_brief(task, session)["revision"]
    for mutate in (
        lambda t, s: t.update(description="New requirement"),
        lambda t, s: s["collaborationRounds"][0].update(roundId="round-2"),
        lambda t, s: s["agentRuns"][0]["workResult"].update(evidence=["Different claim"]),
        lambda t, s: s["artifacts"][0].update(id="file-v2"),
        lambda t, s: t.update(executionOwner={"requestId": "request-2", "revision": 2}),
    ):
        changed_task, changed_session = deepcopy(task), deepcopy(session)
        mutate(changed_task, changed_session)
        assert build_review_brief(changed_task, changed_session)["revision"] != revision


def test_failed_truncated_and_unresolved_work_remains_visible():
    task, session = records()
    session["agentRuns"][0].update(status="failed", exitCode=1, outputTruncated=True)
    session["agentRuns"][0]["workResult"].update(status="blocked", findings=[{"note": "Missing coverage"}])
    report = build_review_brief(task, session)["reports"][0]
    assert report["status"] == "failed"
    assert report["workStatus"] == "blocked"
    assert report["findings"] == ["Missing coverage"]
    assert report["outputTruncated"] is True
