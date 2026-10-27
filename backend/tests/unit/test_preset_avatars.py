from __future__ import annotations

from pathlib import Path

import pytest

from relay.core.preset_avatars import (
    PRESET_AVATAR_URLS,
    RETIRED_PRESET_AVATARS,
    current_preset_avatar_url,
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
    assert len(PRESET_AVATAR_URLS["agents"]) == 48
    assert len(PRESET_AVATAR_URLS["teams"]) == 12


@pytest.mark.parametrize(
    "url",
    [
        "/avatars/agents/lorelei-07.svg",
        "/avatars/agents/lorelei-16.svg",
        "/avatars/agents/lorelei-17.svg",
        "/avatars/agents/lorelei-48.svg",
    ],
)
def test_every_agent_style_is_a_preset(url: str) -> None:
    assert is_preset_avatar_url("agents", url)
    assert not is_preset_avatar_url("teams", url)


def test_presets_are_scoped_to_their_kind() -> None:
    assert is_preset_avatar_url("agents", "/avatars/agents/lorelei-07.svg")
    assert is_preset_avatar_url("teams", "/avatars/teams/shape-grid-03.svg")
    assert not is_preset_avatar_url("teams", "/avatars/agents/lorelei-07.svg")
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
        validate_profile_image_url("agents", "a1", "/avatars/agents/lorelei-01.svg")
        == "/avatars/agents/lorelei-01.svg"
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


def test_retired_styles_are_not_offered_but_upgrade_to_their_own_lorelei_face() -> None:
    assert len(RETIRED_PRESET_AVATARS) == 48
    for retired, replacement in RETIRED_PRESET_AVATARS.items():
        assert not is_preset_avatar_url("agents", retired)
        assert not (WEB_AVATARS / "agents" / retired.rsplit("/", 1)[1]).exists()
        assert is_preset_avatar_url("agents", replacement)
        assert current_preset_avatar_url(retired) == replacement
        assert validate_profile_image_url("agents", "a1", retired) == replacement
    # A robot upgrades to the portrait its pixel-art successor now reads as.
    assert current_preset_avatar_url("/avatars/agents/bottts-07.svg") == "/avatars/agents/lorelei-23.svg"
    assert current_preset_avatar_url("/avatars/agents/pixel-art-07.svg") == "/avatars/agents/lorelei-23.svg"
    assert current_preset_avatar_url("/avatars/agents/personas-07.svg") == "/avatars/agents/lorelei-39.svg"
    # Pixel Art and Personas each land on portraits of their own.
    pixel = {RETIRED_PRESET_AVATARS[f"/avatars/agents/pixel-art-{i:02d}.svg"] for i in range(1, 17)}
    personas = {RETIRED_PRESET_AVATARS[f"/avatars/agents/personas-{i:02d}.svg"] for i in range(1, 17)}
    assert len(pixel) == len(personas) == 16
    assert not pixel & personas


def test_current_preset_avatar_url_leaves_everything_else_alone() -> None:
    for value in (None, "", "/avatars/agents/lorelei-01.svg", "/profile-images/agents/a1?v=1", 3):
        assert current_preset_avatar_url(value) == value
    with pytest.raises(ValueError):
        validate_profile_image_url("teams", "t1", "/avatars/agents/bottts-01.svg")
