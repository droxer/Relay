from __future__ import annotations

from pathlib import Path

import pytest

from relay.core.preset_avatars import (
    PRESET_AVATAR_URLS,
    is_preset_avatar_url,
    validate_profile_image_url,
)


WEB_AVATARS = Path(__file__).resolve().parents[3] / "web" / "public" / "avatars"


def test_every_preset_has_a_committed_svg_and_every_svg_is_a_preset() -> None:
    on_disk = {
        kind: {f"/avatars/{kind}/{path.name}" for path in (WEB_AVATARS / kind).glob("*.svg")}
        for kind in ("agents", "teams")
    }

    assert on_disk == {kind: set(urls) for kind, urls in PRESET_AVATAR_URLS.items()}
    assert len(PRESET_AVATAR_URLS["agents"]) == 64
    assert len(PRESET_AVATAR_URLS["teams"]) == 12


@pytest.mark.parametrize(
    "url",
    [
        "/avatars/agents/bottts-07.svg",
        "/avatars/agents/lorelei-16.svg",
        "/avatars/agents/pixel-art-01.svg",
        "/avatars/agents/personas-09.svg",
    ],
)
def test_every_agent_style_is_a_preset(url: str) -> None:
    assert is_preset_avatar_url("agents", url)
    assert not is_preset_avatar_url("teams", url)


def test_presets_are_scoped_to_their_kind() -> None:
    assert is_preset_avatar_url("agents", "/avatars/agents/bottts-07.svg")
    assert is_preset_avatar_url("teams", "/avatars/teams/shape-grid-03.svg")
    assert not is_preset_avatar_url("teams", "/avatars/agents/bottts-07.svg")
    assert not is_preset_avatar_url("agents", "/avatars/teams/shape-grid-03.svg")


@pytest.mark.parametrize(
    "url",
    [
        "/avatars/agents/bottts-17.svg",
        "/avatars/agents/lorelei-00.svg",
        "/avatars/agents/pixel-art-neutral-01.svg",
        "/avatars/agents/../teams/shape-grid-01.svg",
        "/avatars/agents/bottts-01.svg?x=1",
        "https://api.dicebear.com/10.x/bottts/svg",
        "/avatars/agents/BOTTTS-01.svg",
        "",
    ],
)
def test_anything_outside_the_allowlist_is_not_a_preset(url: str) -> None:
    assert not is_preset_avatar_url("agents", url)


def test_validate_accepts_none_presets_and_the_entitys_own_upload() -> None:
    assert validate_profile_image_url("agents", "a1", None) is None
    assert (
        validate_profile_image_url("agents", "a1", "/avatars/agents/bottts-01.svg")
        == "/avatars/agents/bottts-01.svg"
    )
    assert (
        validate_profile_image_url("agents", "a1", "/profile-images/agents/a1?v=abc")
        == "/profile-images/agents/a1?v=abc"
    )


@pytest.mark.parametrize(
    "url",
    [
        "/profile-images/agents/other?v=abc",
        "/avatars/teams/shape-grid-01.svg",
        "javascript:alert(1)",
        42,
    ],
)
def test_validate_rejects_foreign_uploads_wrong_kind_presets_and_junk(url: object) -> None:
    with pytest.raises(ValueError, match="profileImageUrl is invalid."):
        validate_profile_image_url("agents", "a1", url)
