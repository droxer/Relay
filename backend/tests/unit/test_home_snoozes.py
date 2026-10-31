from __future__ import annotations

import pytest
from relay.security.home_snoozes import (
    MAX_HOME_SNOOZES,
    apply_home_snoozes_patch,
    normalize_home_snoozes,
)


def test_snooze_records_the_item_and_the_stamp_it_was_snoozed_at() -> None:
    record = apply_home_snoozes_patch(None, {"snooze": [{"key": "task:1", "stamp": "v3"}]})

    assert record == [{"key": "task:1", "stamp": "v3"}]


def test_snoozing_again_replaces_the_stamp_and_moves_the_entry_last() -> None:
    current = [{"key": "task:1", "stamp": "v3"}, {"key": "task:2", "stamp": "v1"}]

    record = apply_home_snoozes_patch(current, {"snooze": [{"key": "task:1", "stamp": "v4"}]})

    assert record == [{"key": "task:2", "stamp": "v1"}, {"key": "task:1", "stamp": "v4"}]
    assert current[0] == {"key": "task:1", "stamp": "v3"}


def test_unsnooze_removes_the_entry() -> None:
    current = [{"key": "task:1", "stamp": "v3"}, {"key": "node:a", "stamp": "x"}]

    record = apply_home_snoozes_patch(current, {"unsnooze": ["task:1", "missing"]})

    assert record == [{"key": "node:a", "stamp": "x"}]


def test_the_newest_snoozes_are_kept_past_the_cap() -> None:
    entries = [{"key": f"task:{index}", "stamp": "s"} for index in range(MAX_HOME_SNOOZES)]

    record = apply_home_snoozes_patch(entries, {"snooze": [{"key": "task:new", "stamp": "s"}]})

    assert len(record) == MAX_HOME_SNOOZES
    assert record[0]["key"] == "task:1"
    assert record[-1]["key"] == "task:new"


@pytest.mark.parametrize("patch", [
    "snooze",
    {},
    {"forget": []},
    {"snooze": []},
    {"snooze": [{"key": "task:1"}]},
    {"snooze": [{"key": "", "stamp": "s"}]},
    {"snooze": [{"key": "k" * 513, "stamp": "s"}]},
    {"unsnooze": "task:1"},
    {"unsnooze": [3]},
])
def test_a_malformed_patch_is_refused(patch: object) -> None:
    with pytest.raises(ValueError):
        apply_home_snoozes_patch([], patch)


def test_normalize_drops_whatever_a_past_write_left_malformed() -> None:
    stored = [{"key": "task:1", "stamp": "a"}, {"key": 4}, "junk", {"key": "task:1", "stamp": "b"}]

    assert normalize_home_snoozes(stored) == [{"key": "task:1", "stamp": "b"}]
    assert normalize_home_snoozes({"key": "x"}) == []
