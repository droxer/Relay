from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from relay.persistence.agent_store import DatabaseAgentStore, LocalAgentStore
from relay.services.skill_grants import SkillGrantError, grant, read_grants, revoke


class Skills:
    def __init__(self):
        self.skills = {}
        self.revisions = {}

    def get_skill(self, skill_id):
        return self.skills.get(skill_id)

    def get_revision(self, revision_id):
        return self.revisions.get(revision_id)


@pytest.fixture
def ctx(tmp_path):
    return SimpleNamespace(agent_store=LocalAgentStore(tmp_path), skill_store=Skills())


def _agent(ctx, owner="alice", executor="claude"):
    return ctx.agent_store.create_agent(
        owner,
        {
            "displayName": f"{owner}-{executor}",
            "executorKind": executor,
            "defaultRole": "implementer",
        },
    )


def _skill(ctx, skill_id="skill-1", owner="alice", visibility="private"):
    revision = {"id": f"rev-{skill_id}", "skillId": skill_id}
    skill = {
        "id": skill_id,
        "ownerEmployeeId": owner,
        "visibility": visibility,
        "deletedAt": None,
        "currentRevisionId": revision["id"],
        "slug": skill_id,
    }
    ctx.skill_store.skills[skill_id] = skill
    ctx.skill_store.revisions[revision["id"]] = revision
    return skill


def test_read_grants_tolerates_legacy_and_unknown_keys():
    assert read_grants({"skillPolicy": {}}) == []
    assert read_grants({"skillPolicy": {"version": 1, "future": 3, "grants": []}}) == []
    assert (
        read_grants({"skillPolicy": {"version": 99, "grants": [{"skillId": "x"}]}})
        == []
    )


def test_grant_is_idempotent_preserves_policy_keys_and_codex_is_included(ctx):
    agent = _agent(ctx, executor="codex")
    ctx.agent_store.update_agent(agent["id"], {"skillPolicy": {"future": "kept"}})
    skill = _skill(ctx)
    grant(ctx, skill["id"], [agent["id"]], "alice")
    grant(ctx, skill["id"], [agent["id"]], "alice")
    stored = ctx.agent_store.get_agent(agent["id"])
    assert stored["skillPolicy"]["future"] == "kept"
    assert stored["skillPolicy"]["version"] == 1
    assert len(read_grants(stored)) == 1
    assert read_grants(stored)[0]["pin"] == "latest"


def test_grant_validates_pin_belongs_to_skill(ctx):
    agent = _agent(ctx)
    skill = _skill(ctx)
    ctx.skill_store.revisions["foreign"] = {"id": "foreign", "skillId": "other"}
    with pytest.raises(SkillGrantError) as exc:
        grant(ctx, skill["id"], [agent["id"]], "alice", {"revisionId": "foreign"})
    assert exc.value.code == "revision-not-found"


def test_fanout_prevalidates_all_agents_before_writing(ctx):
    mine, theirs = _agent(ctx), _agent(ctx, "bob")
    skill = _skill(ctx)
    with pytest.raises(SkillGrantError) as exc:
        grant(ctx, skill["id"], [mine["id"], theirs["id"]], "alice")
    assert exc.value.code == "not-agent-owner"
    assert read_grants(ctx.agent_store.get_agent(mine["id"])) == []


def test_private_skill_is_not_visible_to_other_owner(ctx):
    agent = _agent(ctx)
    skill = _skill(ctx, owner="bob")
    with pytest.raises(SkillGrantError) as exc:
        grant(ctx, skill["id"], [agent["id"]], "alice")
    assert exc.value.code == "skill-not-found"


def test_unknown_policy_version_rejects_mutation(ctx):
    agent = _agent(ctx)
    skill = _skill(ctx)
    ctx.agent_store.update_agent(
        agent["id"], {"skillPolicy": {"version": 2, "grants": []}}
    )
    with pytest.raises(SkillGrantError) as exc:
        grant(ctx, skill["id"], [agent["id"]], "alice")
    assert exc.value.code == "unsupported-policy-version"


def test_parallel_independent_grants_are_not_lost_and_revoke_is_scoped(ctx):
    agent = _agent(ctx)
    skills = [_skill(ctx, f"skill-{i}") for i in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(
            pool.map(
                lambda skill: grant(ctx, skill["id"], [agent["id"]], "alice"), skills
            )
        )
    assert {
        item["skillId"] for item in read_grants(ctx.agent_store.get_agent(agent["id"]))
    } == {"skill-0", "skill-1"}
    revoke(ctx, "skill-0", agent["id"], "alice")
    assert [
        item["skillId"] for item in read_grants(ctx.agent_store.get_agent(agent["id"]))
    ] == ["skill-1"]


def test_database_policy_transform_is_atomic_and_event_sourced(tmp_path):
    ctx = SimpleNamespace(
        agent_store=DatabaseAgentStore(
            f"sqlite:///{tmp_path}/agents.db", create_schema=True
        ),
        skill_store=Skills(),
    )
    agent = _agent(ctx)
    skills = [_skill(ctx, f"db-skill-{i}") for i in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(
            pool.map(
                lambda skill: grant(ctx, skill["id"], [agent["id"]], "alice"),
                skills,
            )
        )
    stored = ctx.agent_store.get_agent(agent["id"])
    assert {entry["skillId"] for entry in read_grants(stored)} == {
        "db-skill-0",
        "db-skill-1",
    }
    assert [event["type"] for event in ctx.agent_store.events(agent["id"])][-2:] == [
        "agent.updated",
        "agent.updated",
    ]
