from types import SimpleNamespace

import pytest

from relay.persistence.project_store import ProjectValidationError
from relay.services.project_catalog import update_project_payload


def member(agent_id, *, enabled=True):
    return dict(agentId=agent_id, role="implementer",
                responsibilities="Build", enabled=enabled)


def update(current, members, *, disabled=(), misplaced=(), lead="lead", foreign=()):
    return update_project_payload(
        "alice", current,
        dict(expectedVersion=1, members=members, leadAgentId=lead),
        agent_store=SimpleNamespace(get_agent=lambda agent_id: dict(
            id=agent_id, enabled=agent_id not in disabled,
            supervisorEmployeeId="bob" if agent_id in foreign else "alice")),
        placement_store=SimpleNamespace(list_placements=lambda *, agent_id: [dict(
            desiredState="active", computerId="other" if agent_id in misplaced else "computer")] ),
    )[0]


def project():
    return dict(members=[member("lead"), member("a"), member("b")],
                leadAgentId="lead", computerId="computer")


@pytest.mark.parametrize("unhealthy", ["disabled", "misplaced"])
def test_can_remove_members_incrementally_when_multiple_members_are_unhealthy(unhealthy):
    current = project()
    patch = update(current, [member("lead"), member("b")], **{unhealthy: ("a", "b")})
    assert [item["agentId"] for item in patch["members"]] == ["lead", "b"]


def test_can_disable_an_existing_globally_disabled_member():
    patch = update(project(), [member("lead"), member("a", enabled=False), member("b")], disabled=("a",))
    assert patch["members"][1]["enabled"] is False


@pytest.mark.parametrize("operation", ["add", "enable", "lead"])
def test_new_members_activation_and_lead_changes_still_require_readiness(operation):
    current = project()
    if operation == "add":
        current["members"] = [member("lead"), member("b")]
    elif operation == "enable":
        current["members"][1]["enabled"] = False
    with pytest.raises(ProjectValidationError, match="project_member_disabled"):
        update(current, project()["members"], disabled=("a",), lead="a" if operation == "lead" else "lead")


def test_existing_members_cannot_bypass_ownership_checks():
    with pytest.raises(ProjectValidationError, match="project_member_wrong_owner"):
        update(project(), project()["members"], foreign=("a",))
