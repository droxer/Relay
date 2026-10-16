"""The onboarding wizard's stored choices on an Account.

Progress through the wizard is derived on the client from what exists — a
connected Computer, a placed Agent, a finished run — so the only state kept
here is what a person chose: that they read the intro, that they dismissed the
wizard, and which "Explore next" cards they closed. See
`docs/onboarding-wizard-design.md`.

A client never writes timestamps. It sends intents (`introSeen`, `dismissed`,
`closedCards`) and the server stamps them, so the stored record is always the
shape `normalize_onboarding` reads.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

ONBOARDING_CARDS: tuple[str, ...] = ("tasks", "projects", "teams", "automations")
_PATCH_KEYS = frozenset({"introSeen", "dismissed", "closedCards"})


def normalize_onboarding(value: Any) -> dict[str, Any]:
    """The stored record, tolerant of anything a past write left behind."""
    if not isinstance(value, Mapping):
        return {}
    record: dict[str, Any] = {}
    for key in ("introSeenAt", "dismissedAt"):
        stamp = value.get(key)
        if isinstance(stamp, str) and stamp:
            record[key] = stamp
    cards = value.get("closedCards")
    if isinstance(cards, list):
        closed = [card for card in ONBOARDING_CARDS if card in cards]
        if closed:
            record["closedCards"] = closed
    return record


def apply_onboarding_patch(current: Any, patch: Any, now: str) -> dict[str, Any]:
    """Return a new record with `patch` applied; raise ValueError on a bad patch."""
    if not isinstance(patch, Mapping):
        raise ValueError("onboarding must be an object.")
    unknown = set(patch) - _PATCH_KEYS
    if unknown:
        raise ValueError(f"onboarding has unknown field(s): {', '.join(sorted(unknown))}.")
    record = normalize_onboarding(current)
    if "introSeen" in patch:
        record = _with_stamp(record, "introSeenAt", _bool_field(patch, "introSeen"), now)
    if "dismissed" in patch:
        record = _with_stamp(record, "dismissedAt", _bool_field(patch, "dismissed"), now)
    if "closedCards" in patch:
        closed = _closed_cards(patch["closedCards"])
        record = {key: value for key, value in record.items() if key != "closedCards"}
        if closed:
            record["closedCards"] = closed
    return record


def _with_stamp(record: dict[str, Any], key: str, on: bool, now: str) -> dict[str, Any]:
    if not on:
        return {name: value for name, value in record.items() if name != key}
    # The first time a choice was made is the one worth keeping.
    return record if key in record else {**record, key: now}


def _bool_field(patch: Mapping[str, Any], key: str) -> bool:
    value = patch[key]
    if not isinstance(value, bool):
        raise ValueError(f"onboarding.{key} must be a boolean.")
    return value


def _closed_cards(value: Any) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(card, str) for card in value):
        raise ValueError("onboarding.closedCards must be a list of card ids.")
    unknown = sorted(set(value) - set(ONBOARDING_CARDS))
    if unknown:
        raise ValueError(f"onboarding.closedCards has unknown card(s): {', '.join(unknown)}.")
    return [card for card in ONBOARDING_CARDS if card in value]
