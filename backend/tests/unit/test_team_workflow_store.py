from copy import deepcopy

import pytest

from relay.persistence.team.store import DatabaseTeamStore


def workflow_payload():
    return {
        "name": "Workflow", "leadAgentId": "lead", "memberAgentIds": ["lead", "builder"],
        "projectId": "project", "computerId": "computer",
        "workflowSteps": [
            {"id": name, "name": name.title(), "agentId": agent, "instructions": "Do the work",
             "expectedOutputs": ["Evidence"], "acceptanceCriteria": ["Verified"], "kind": kind}
            for name, agent, kind in [
                ("design", "lead", "work"), ("develop", "builder", "work"),
                ("verify", "lead", "work"), ("deploy", "builder", "deployment"),
            ]
        ],
    }


@pytest.fixture
def store(tmp_path):
    return DatabaseTeamStore(f"sqlite:///{tmp_path}/workflow.db", create_schema=True)


def test_order_defaults_and_events_round_trip(store):
    payload = workflow_payload()
    team = store.create_team("owner", payload)
    assert team["projectId"] == "project"
    assert [s["requiresApproval"] for s in team["workflowSteps"]] == [False, False, False, True]
    steps = list(reversed(team["workflowSteps"]))
    updated = store.update_team(team["id"], {"workflowSteps": steps})
    assert store.get_team(team["id"]) == updated
    assert store.events(team["id"])[-1]["team"]["workflowSteps"] == steps
    assert store.events(team["id"])[0]["team"]["workflowSteps"] == team["workflowSteps"]
    assert [s["id"] for s in updated["workflowSteps"]] == ["deploy", "verify", "develop", "design"]


@pytest.mark.parametrize("patch", [
    {"projectId": None}, {"projectId": "elsewhere"}, {"projectId": ""},
    {"workflowSteps": None}, {"workflowSteps": []}, {"workflowSteps": "steps"},
    {"workflowSteps": [{}]}, {"workflowSteps": [None]},
    {"memberAgentIds": ["lead"]},
])
def test_invalid_update_leaves_snapshot_and_events_unchanged(store, patch):
    team = store.create_team("owner", workflow_payload())
    events = store.events(team["id"])
    with pytest.raises(ValueError):
        store.update_team(team["id"], patch)
    assert store.get_team(team["id"]) == team
    assert store.events(team["id"]) == events


@pytest.mark.parametrize("field,value", [
    ("id", ""), ("id", "a" * 65), ("name", " "), ("instructions", 123),
    ("agentId", "outsider"), ("requiresApproval", "false"), ("kind", "parallel"),
    ("expectedOutputs", []), ("expectedOutputs", "file"),
    ("acceptanceCriteria", [""]), ("unknown", True),
])
def test_invalid_step_never_creates_team(store, field, value):
    payload = workflow_payload()
    payload["workflowSteps"][0][field] = value
    with pytest.raises(ValueError):
        store.create_team("owner", payload)
    assert store.list_teams() == []


def test_duplicate_ids_and_partial_contract_are_rejected(store):
    for change in ("duplicate", "project", "steps", "too_many", "style", "approval"):
        payload = deepcopy(workflow_payload())
        if change == "duplicate":
            payload["workflowSteps"][1]["id"] = "design"
        elif change == "project":
            del payload["projectId"]
        elif change == "steps":
            del payload["workflowSteps"]
        elif change == "too_many":
            payload["workflowSteps"] *= 17
        elif change == "style":
            payload["collaborationStyle"] = "pipeline"
        else:
            payload["humanApproval"] = True
        with pytest.raises(ValueError):
            store.create_team("owner", payload)
    assert store.list_teams() == []


def test_member_removal_keeps_step_evidence_and_cannot_restore_legacy_execution(store):
    team = store.create_team("owner", workflow_payload())
    removed = store.remove_member(team["id"], "builder")
    assert removed["workflowSteps"] == team["workflowSteps"]
    assert removed["projectId"] == team["projectId"]
    with pytest.raises(ValueError):
        store.update_team(team["id"], {"projectId": None, "workflowSteps": None})
