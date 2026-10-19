from __future__ import annotations

import base64
from pathlib import Path

import pytest

from relay.persistence.account.profile_images import LocalProfileImageStore, ProfileImageError
from relay.persistence.agent.store import DatabaseAgentStore
from relay.persistence.team.store import DatabaseTeamStore


PNG_BYTES = b"\x89PNG\r\n\x1a\nrelay-profile"


def data_url(content_type: str, content: bytes) -> str:
    return f"data:{content_type};base64,{base64.b64encode(content).decode('ascii')}"


def test_profile_image_store_replaces_formats_and_versions_urls(tmp_path: Path) -> None:
    store = LocalProfileImageStore(tmp_path)

    first_url = store.save("agents", "agent_1", data_url("image/png", PNG_BYTES))
    second_url = store.save(
        "agents",
        "agent_1",
        data_url("image/jpeg", b"\xff\xd8\xffrelay-profile"),
    )

    assert first_url.startswith("/profile-images/agents/agent_1?v=")
    assert second_url.startswith("/profile-images/agents/agent_1?v=")
    assert first_url != second_url
    assert store.read("agents", "agent_1")[:2] == (
        b"\xff\xd8\xffrelay-profile",
        "image/jpeg",
    )
    assert not (tmp_path / "profile-images" / "agents" / "agent_1.png").exists()


def test_profile_image_store_rejects_mismatched_content(tmp_path: Path) -> None:
    store = LocalProfileImageStore(tmp_path)

    with pytest.raises(ProfileImageError, match="profile_image_invalid"):
        store.save("teams", "team_1", data_url("image/png", b"not a png"))


def test_profile_image_store_deletes_an_image(tmp_path: Path) -> None:
    store = LocalProfileImageStore(tmp_path)
    store.save("teams", "team_1", data_url("image/png", PNG_BYTES))

    store.delete("teams", "team_1")

    assert store.read("teams", "team_1") is None


def test_database_profile_snapshots_store_only_versioned_image_urls(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path}/profiles.db"
    agents = DatabaseAgentStore(database_url, create_schema=True)
    teams = DatabaseTeamStore(database_url, create_schema=True)
    agent = agents.create_agent(
        "alice", {"displayName": "Builder", "executorKind": "codex", "defaultRole": "implementer"}
    )
    team = teams.create_team(
        "alice",
        {
            "name": "Delivery",
            "leadAgentId": agent["id"],
            "memberAgentIds": [agent["id"]],
        },
    )
    agent_url = f"/profile-images/agents/{agent['id']}?v=abc123"
    team_url = f"/profile-images/teams/{team['id']}?v=def456"

    updated_agent = agents.update_agent(
        agent["id"], {"profileImageUrl": agent_url}
    )
    updated_team = teams.update_team(team["id"], {"profileImageUrl": team_url})

    assert updated_agent["profileImageUrl"] == agent_url
    assert updated_team["profileImageUrl"] == team_url
    assert DatabaseAgentStore(database_url).get_agent(agent["id"])[
        "profileImageUrl"
    ] == agent_url
    assert DatabaseTeamStore(database_url).get_team(team["id"])[
        "profileImageUrl"
    ] == team_url
