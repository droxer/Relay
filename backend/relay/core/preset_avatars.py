"""The preset profile images an agent or team may pick instead of an upload.

The SVGs are static files in the exported web UI (``web/public/avatars/``),
so a preset's ``profileImageUrl`` is simply its path there. This allowlist is
exact-match on purpose: a stored URL is rendered as an ``<img src>`` on every
surface, so nothing but a known file may be accepted. Keep it in step with
``web/src/lib/presetAvatars.ts``; ``tests/unit/test_preset_avatars.py`` checks
both against the files on disk.
"""

from __future__ import annotations

from typing import Any

# (style, count) per kind, in picker order.
PRESET_AVATAR_STYLES: dict[str, tuple[tuple[str, int], ...]] = {
    "agents": (("lorelei", 16), ("pixel-art", 16), ("personas", 16)),
    "teams": (("shape-grid", 12),),
}

# The Bottts robots were retired (2026-10-24): a robot face is the stock
# picture of "AI", the opposite of a named colleague. Their files are gone, so
# a stored robot reads as the pixel-art face with the same number, upgraded on
# read and on write; the event log keeps what was chosen.
RETIRED_PRESET_AVATARS: dict[str, str] = {
    f"/avatars/agents/bottts-{index:02d}.svg": f"/avatars/agents/pixel-art-{index:02d}.svg"
    for index in range(1, 17)
}

PRESET_AVATAR_URLS: dict[str, frozenset[str]] = {
    kind: frozenset(
        f"/avatars/{kind}/{style}-{index:02d}.svg"
        for style, count in styles
        for index in range(1, count + 1)
    )
    for kind, styles in PRESET_AVATAR_STYLES.items()
}


def current_preset_avatar_url(url: Any) -> Any:
    """A retired preset's replacement; any other value unchanged."""
    return RETIRED_PRESET_AVATARS.get(url, url) if isinstance(url, str) else url


def is_preset_avatar_url(kind: str, url: object) -> bool:
    return isinstance(url, str) and url in PRESET_AVATAR_URLS.get(kind, frozenset())


def validate_profile_image_url(kind: str, entity_id: str, url: Any) -> str | None:
    """Accept no image, a preset of this kind, or this entity's own upload.

    A retired preset is accepted as its replacement, so an older client that
    still offers it upgrades the record rather than failing."""
    url = current_preset_avatar_url(url)
    if url is None or is_preset_avatar_url(kind, url):
        return url
    if isinstance(url, str) and url.startswith(f"/profile-images/{kind}/{entity_id}?v="):
        return url
    raise ValueError("profileImageUrl is invalid.")
