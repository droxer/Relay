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

PRESET_AVATAR_COUNTS = {"agents": ("bottts", 16), "teams": ("shape-grid", 12)}

PRESET_AVATAR_URLS: dict[str, frozenset[str]] = {
    kind: frozenset(
        f"/avatars/{kind}/{style}-{index:02d}.svg" for index in range(1, count + 1)
    )
    for kind, (style, count) in PRESET_AVATAR_COUNTS.items()
}


def is_preset_avatar_url(kind: str, url: object) -> bool:
    return isinstance(url, str) and url in PRESET_AVATAR_URLS.get(kind, frozenset())


def validate_profile_image_url(kind: str, entity_id: str, url: Any) -> str | None:
    """Accept no image, a preset of this kind, or this entity's own upload."""
    if url is None or is_preset_avatar_url(kind, url):
        return url
    if isinstance(url, str) and url.startswith(f"/profile-images/{kind}/{entity_id}?v="):
        return url
    raise ValueError("profileImageUrl is invalid.")
