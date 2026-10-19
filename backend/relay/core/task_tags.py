"""Task tags: the free-form labels a person files tasks and automations under.

A tag is trimmed, its inner whitespace collapsed to one space, and kept in the
spelling it was first written in; two tags that differ only by case are the
same tag, so the first spelling wins. Commas separate tags where people type
them, so a tag cannot contain one. The web mirror is ``web/src/lib/taskTags.ts``.
"""

from __future__ import annotations

from typing import Any

MAX_TAGS = 10
MAX_TAG_CHARS = 32
TAGS_DETAIL = (
    f"tags must be a list of at most {MAX_TAGS} strings, "
    f"each 1–{MAX_TAG_CHARS} characters without commas."
)


def normalize_tag(value: Any) -> str:
    """One tag in its stored spelling; raises ``ValueError`` when invalid."""
    if not isinstance(value, str):
        raise ValueError(TAGS_DETAIL)
    tag = " ".join(value.split())
    if (
        not tag
        or len(tag) > MAX_TAG_CHARS
        or "," in tag
        or any(not ch.isprintable() for ch in tag)
    ):
        raise ValueError(TAGS_DETAIL)
    return tag


def normalize_tags(value: Any) -> list[str]:
    """A tag list deduped case-insensitively; raises ``ValueError`` when invalid."""
    if not isinstance(value, list):
        raise ValueError(TAGS_DETAIL)
    tags: list[str] = []
    seen: set[str] = set()
    for item in value:
        tag = normalize_tag(item)
        key = tag.casefold()
        if key not in seen:
            seen.add(key)
            tags.append(tag)
    if len(tags) > MAX_TAGS:
        raise ValueError(TAGS_DETAIL)
    return tags
