from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

import pytest
from relay.core.ids import now_iso
from relay.persistence.skill_store import DatabaseSkillStore
from relay.persistence.store_common import _parse_iso
from relay.services.skill_assignments import (
    SkillAssignmentError,
    assign,
    effective_assignments,
    revoke,
)
from sqlalchemy import insert


def _files(name: str = "review") -> list[dict]:
    return [
        {
            "path": "SKILL.md",
            "content": (
                f"---\nname: {name}\ndescription: Reviews code\n---\nReview carefully."
            ).encode(),
        }
    ]


def _store(tmp_path) -> tuple[DatabaseSkillStore, str, str]:
    store = DatabaseSkillStore(f"sqlite:///{tmp_path}/relay.db", create_schema=True)
    alice, bob = str(uuid4()), str(uuid4())
    with store.engine.begin() as conn:
        for employee_id, handle in ((alice, "alice"), (bob, "bob")):
            conn.execute(
                insert(store.employees).values(
                    id=employee_id,
                    handle=handle,
                    display_name=handle.title(),
                    email=None,
                    department_id=None,
                    max_local_computers=None,
                    created_at=_parse_iso(now_iso()),
                    updated_at=_parse_iso(now_iso()),
                    deleted_at=None,
                )
            )
    return store, alice, bob


def _skill(store: DatabaseSkillStore, owner: str, name: str = "review") -> dict:
    return store.create_skill(
        owner,
        {
            "name": name,
            "visibility": "org",
            "source": "authored",
            "files": _files(name),
        },
    )


def test_assignment_store_upserts_and_revokes_scoped_targets(tmp_path):
    store, alice, _ = _store(tmp_path)
    skill = _skill(store, alice)

    first = store.upsert_assignment(
        skill["id"],
        target_type="employee",
        target_id=alice,
        mode="optional",
        pin="stable",
        invocation="implicit",
        created_by_employee_id=alice,
    )
    second = store.upsert_assignment(
        skill["id"],
        target_type="employee",
        target_id=alice,
        mode="required",
        pin="latest",
        invocation="implicit",
        created_by_employee_id=alice,
    )

    assert second["id"] == first["id"]
    assert second["mode"] == "required"
    assert store.list_assignments(
        targets=[("employee", alice)]
    ) == [second]
    assert store.delete_assignment(second["id"])["id"] == second["id"]
    assert store.list_assignments(skill_id=skill["id"]) == []


class _AgentStore:
    def __init__(self, agents: list[dict]):
        self.agents = {agent["id"]: agent for agent in agents}

    def get_agent(self, agent_id: str):
        return self.agents.get(agent_id)


class _TargetStore:
    def __init__(self, records: list[dict]):
        self.records = {record["id"]: record for record in records}

    def get_team(self, target_id: str):
        return self.records.get(target_id)

    def get_project(self, target_id: str):
        return self.records.get(target_id)

    def list_teams(self, owner_employee_id=None):
        return [
            record
            for record in self.records.values()
            if owner_employee_id is None
            or record.get("ownerEmployeeId") == owner_employee_id
        ]


def _ctx(store, alice: str, bob: str):
    agents = [
        {
            "id": "agent-a",
            "supervisorEmployeeId": alice,
            "enabled": True,
            "skillPolicy": {},
        },
        {
            "id": "agent-b",
            "supervisorEmployeeId": bob,
            "enabled": True,
            "skillPolicy": {},
        },
    ]
    teams = _TargetStore(
        [
            {
                "id": "team-a",
                "ownerEmployeeId": alice,
                "memberAgentIds": ["agent-a"],
                "deletedAt": None,
            },
            {
                "id": "team-b",
                "ownerEmployeeId": bob,
                "memberAgentIds": ["agent-b"],
                "deletedAt": None,
            },
        ]
    )
    projects = _TargetStore(
        [
            {
                "id": "project-a",
                "ownerEmployeeId": alice,
                "members": [{"agentId": "agent-a", "enabled": True}],
                "archivedAt": None,
            }
        ]
    )
    return SimpleNamespace(
        skill_store=store,
        agent_store=_AgentStore(agents),
        team_store=teams,
        project_store=projects,
    )


def test_assignment_service_enforces_target_ownership(tmp_path):
    store, alice, bob = _store(tmp_path)
    skill = _skill(store, alice)
    ctx = _ctx(store, alice, bob)

    with pytest.raises(SkillAssignmentError) as error:
        assign(ctx, skill["id"], "agent", "agent-b", alice)
    assert error.value.code == "not-target-owner"

    with pytest.raises(SkillAssignmentError) as error:
        assign(ctx, skill["id"], "employee", bob, alice)
    assert error.value.code == "not-target-owner"

    with pytest.raises(SkillAssignmentError) as error:
        assign(ctx, skill["id"], "team", "team-b", alice)
    assert error.value.code == "not-target-owner"


def test_employee_team_project_and_agent_assignments_are_dynamic(tmp_path):
    store, alice, bob = _store(tmp_path)
    ctx = _ctx(store, alice, bob)
    employee_skill = _skill(store, alice, "employee-review")
    team_skill = _skill(store, alice, "team-review")
    project_skill = _skill(store, alice, "project-review")
    agent_skill = _skill(store, alice, "agent-review")

    assign(ctx, employee_skill["id"], "employee", alice, alice)
    assign(ctx, team_skill["id"], "team", "team-a", alice)
    assign(ctx, project_skill["id"], "project", "project-a", alice)
    assign(ctx, agent_skill["id"], "agent", "agent-a", alice)

    agent = ctx.agent_store.get_agent("agent-a")
    without_project = effective_assignments(ctx, agent)
    with_project = effective_assignments(ctx, agent, project_id="project-a")

    assert {item["skillId"] for item in without_project} == {
        employee_skill["id"],
        team_skill["id"],
        agent_skill["id"],
    }
    assert {item["skillId"] for item in with_project} == {
        employee_skill["id"],
        team_skill["id"],
        project_skill["id"],
        agent_skill["id"],
    }

    ctx.team_store.records["team-a"]["memberAgentIds"] = []
    assert team_skill["id"] not in {
        item["skillId"] for item in effective_assignments(ctx, agent)
    }


def test_suggested_assignment_is_visible_but_not_auto_delivered(tmp_path):
    store, alice, bob = _store(tmp_path)
    ctx = _ctx(store, alice, bob)
    skill = _skill(store, alice)
    assignment = assign(
        ctx,
        skill["id"],
        "employee",
        alice,
        alice,
        mode="suggested",
        invocation="explicit",
    )

    assert assignment["mode"] == "suggested"
    assert effective_assignments(ctx, ctx.agent_store.get_agent("agent-a")) == []


def test_revoke_requires_the_assignment_target_owner(tmp_path):
    store, alice, bob = _store(tmp_path)
    ctx = _ctx(store, alice, bob)
    skill = _skill(store, alice)
    assignment = assign(ctx, skill["id"], "employee", alice, alice)

    with pytest.raises(SkillAssignmentError) as error:
        revoke(ctx, assignment["id"], bob)
    assert error.value.code == "not-target-owner"
    assert revoke(ctx, assignment["id"], alice)["id"] == assignment["id"]
