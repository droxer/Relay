from __future__ import annotations

from types import SimpleNamespace

from relay.services.skill_bundle import resolve_bundle


class Store:
    def __init__(self):
        self.skills = {}
        self.revisions = {}
        self.files = {}
        self.assignments = []

    def get_skill(self, skill_id):
        return self.skills.get(skill_id)

    def get_revision(self, revision_id):
        return self.revisions.get(revision_id)

    def revision_files(self, revision_id):
        return self.files[revision_id]

    def list_assignments(self, *, targets=None, skill_id=None):
        target_set = set(targets or [])
        return [
            assignment
            for assignment in self.assignments
            if (not target_set or (assignment["targetType"], assignment["targetId"]) in target_set)
            and (skill_id is None or assignment["skillId"] == skill_id)
        ]


def _ctx():
    store = Store()
    for skill_id, owner, visibility in (("b", "alice", "private"), ("a", "bob", "org")):
        revision_id = f"rev-{skill_id}"
        store.skills[skill_id] = {
            "id": skill_id,
            "name": skill_id,
            "ownerEmployeeId": owner,
            "visibility": visibility,
            "deletedAt": None,
            "slug": skill_id,
            "currentRevisionId": revision_id,
        }
        store.revisions[revision_id] = {
            "id": revision_id,
            "skillId": skill_id,
            "manifestSha256": f"sha-{skill_id}",
        }
        store.files[revision_id] = [
            {
                "path": "SKILL.md",
                "sha256": f"blob-{skill_id}",
                "bytes": 3,
                "content": b"secret",
            }
        ]
    return SimpleNamespace(skill_store=store)


def _agent(grants, owner="alice", version=1):
    return {
        "id": "agent",
        "supervisorEmployeeId": owner,
        "skillPolicy": {"version": version, "grants": grants},
    }


def _grant(skill_id, pin="latest"):
    return {
        "skillId": skill_id,
        "pin": pin,
        "grantedAt": "now",
        "grantedByEmployeeId": "alice",
    }


def test_explicit_v1_empty_policy_returns_versioned_empty_bundle():
    bundle, skipped = resolve_bundle(_ctx(), _agent([]))
    assert bundle == {
        "contract": {"name": "relay.agent.skills", "version": 1},
        "skills": [],
    }
    assert skipped == []


def test_default_legacy_policy_is_unmanaged():
    bundle, skipped = resolve_bundle(
        _ctx(), {"id": "agent", "supervisorEmployeeId": "alice", "skillPolicy": {}}
    )
    assert bundle is None
    assert skipped == []


def test_resolves_dedupes_sorts_and_never_returns_content():
    bundle, skipped = resolve_bundle(
        _ctx(), _agent([_grant("b"), _grant("a"), _grant("a")])
    )
    assert skipped == []
    assert [item["slug"] for item in bundle["skills"]] == ["a", "b"]
    assert set(bundle["skills"][0]["files"][0]) == {"path", "sha256", "bytes"}


def test_honors_old_pin_after_latest_changes():
    ctx = _ctx()
    ctx.skill_store.revisions["old"] = {
        "id": "old",
        "skillId": "b",
        "manifestSha256": "old-sha",
    }
    ctx.skill_store.files["old"] = []
    bundle, _ = resolve_bundle(ctx, _agent([_grant("b", {"revisionId": "old"})]))
    assert bundle["skills"][0]["revisionId"] == "old"


def test_reports_deleted_missing_revision_and_revoked_visibility():
    ctx = _ctx()
    ctx.skill_store.skills["b"]["deletedAt"] = "now"
    ctx.skill_store.skills["a"]["visibility"] = "private"
    grants = [
        _grant("b"),
        _grant("missing"),
        _grant("a"),
        _grant("b", {"revisionId": "gone"}),
    ]
    bundle, skipped = resolve_bundle(ctx, _agent(grants))
    assert bundle["skills"] == []
    assert {item["reason"] for item in skipped} == {
        "deleted",
        "skill-missing",
        "visibility-revoked",
    }
    assert all({"skillId", "reason"} <= set(item) for item in skipped)
    assert next(item for item in skipped if item["skillId"] == "missing") == {
        "skillId": "missing", "reason": "skill-missing",
    }


def test_reports_revision_missing_without_falling_back():
    bundle, skipped = resolve_bundle(
        _ctx(), _agent([_grant("b", {"revisionId": "gone"})])
    )
    assert bundle["skills"] == []
    assert skipped == [{"skillId": "b", "slug": "b", "reason": "revision-missing"}]


def test_unsupported_policy_is_reported():
    bundle, skipped = resolve_bundle(_ctx(), _agent([_grant("b")], version=2))
    assert bundle["skills"] == []
    assert skipped == [{"skillId": "b", "slug": "b", "reason": "unsupported-policy"}]


def test_kimi_same_name_candidates_keep_deterministic_slug_winner():
    ctx = _ctx()
    ctx.skill_store.skills["a"].update(name="review", slug="team-a/review")
    ctx.skill_store.skills["b"].update(name="Review", slug="team-b/review")
    agent = {**_agent([_grant("b"), _grant("a")]), "executorKind": "kimi"}

    bundle, skipped = resolve_bundle(ctx, agent)

    assert [skill["skillId"] for skill in bundle["skills"]] == ["a"]
    assert skipped == [
        {"skillId": "b", "slug": "team-b/review", "reason": "name-conflict"}
    ]


def test_kimi_different_names_do_not_conflict():
    ctx = _ctx()
    ctx.skill_store.skills["a"].update(name="review", slug="team/review")
    ctx.skill_store.skills["b"].update(name="testing", slug="team/testing")
    agent = {**_agent([_grant("b"), _grant("a")]), "executorKind": "kimi"}

    bundle, skipped = resolve_bundle(ctx, agent)

    assert [skill["skillId"] for skill in bundle["skills"]] == ["a", "b"]
    assert skipped == []


def test_employee_assignment_is_resolved_without_legacy_agent_policy():
    ctx = _ctx()
    ctx.skill_store.assignments.append(
        {
            "id": "assignment",
            "skillId": "b",
            "targetType": "employee",
            "targetId": "alice",
            "mode": "optional",
            "pin": "stable",
            "invocation": "implicit",
            "updatedAt": "now",
        }
    )
    ctx.skill_store.skills["b"]["stableRevisionId"] = "rev-b"

    bundle, skipped = resolve_bundle(
        ctx,
        {"id": "agent", "supervisorEmployeeId": "alice", "skillPolicy": {}},
    )

    assert skipped == []
    assert bundle["skills"][0]["skillId"] == "b"
    assert bundle["skills"][0]["assignmentMode"] == "optional"


def test_explicit_assignment_does_not_auto_materialize():
    ctx = _ctx()
    ctx.skill_store.assignments.append(
        {
            "id": "assignment",
            "skillId": "b",
            "targetType": "employee",
            "targetId": "alice",
            "mode": "suggested",
            "pin": "latest",
            "invocation": "explicit",
            "updatedAt": "now",
        }
    )

    bundle, skipped = resolve_bundle(
        ctx,
        {"id": "agent", "supervisorEmployeeId": "alice", "skillPolicy": {}},
    )

    assert skipped == []
    assert bundle is None
