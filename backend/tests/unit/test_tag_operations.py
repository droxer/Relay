"""Pure rules for a personal tag catalog operation (``relay.core.tag_operations``)."""

from __future__ import annotations

import pytest

from relay.core.tag_operations import (
    TagOperationError,
    parse_tag_operation,
    rewrite_tags,
)


def test_rename_keeps_position_and_other_tags_and_matches_any_case() -> None:
    operation = parse_tag_operation({"operation": "rename", "name": "bug", "newName": " Defect "})
    assert operation.new_name == "Defect"
    assert rewrite_tags(["ui", "BUG", "infra"], operation) == ["ui", "Defect", "infra"]


def test_rename_leaves_unrelated_lists_alone() -> None:
    operation = parse_tag_operation({"operation": "rename", "name": "bug", "newName": "defect"})
    assert rewrite_tags(["ui"], operation) is None
    assert rewrite_tags([], operation) is None


def test_case_only_rename_rewrites_the_spelling() -> None:
    operation = parse_tag_operation({"operation": "rename", "name": "bug", "newName": "Bug"})
    assert rewrite_tags(["bug", "ui"], operation) == ["Bug", "ui"]
    assert rewrite_tags(["Bug"], operation) is None


def test_merge_deduplicates_into_the_target_at_its_first_position() -> None:
    operation = parse_tag_operation(
        {"operation": "merge", "sources": ["frontend", "Web"], "target": "UI"}
    )
    assert rewrite_tags(["x", "web", "ui", "Frontend", "y"], operation) == ["x", "UI", "y"]
    assert rewrite_tags(["ui", "x"], operation) is None


def test_delete_removes_only_the_named_tag() -> None:
    operation = parse_tag_operation({"operation": "delete", "name": "Bug"})
    assert rewrite_tags(["ui", "bug", "infra"], operation) == ["ui", "infra"]
    assert rewrite_tags(["bug"], operation) == []


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"operation": "explode", "name": "a"}, "tag_operation_invalid"),
        ("rename", "tag_operation_invalid"),
        ({"operation": "rename", "name": "a"}, "tag_invalid"),
        ({"operation": "rename", "name": "a", "newName": "b,c"}, "tag_invalid"),
        ({"operation": "rename", "name": "a", "newName": "x" * 33}, "tag_invalid"),
        ({"operation": "rename", "name": "Bug", "newName": " Bug "}, "tag_unchanged"),
        ({"operation": "delete", "name": ""}, "tag_invalid"),
        ({"operation": "merge", "sources": [], "target": "a"}, "tag_operation_invalid"),
        ({"operation": "merge", "sources": "a", "target": "b"}, "tag_operation_invalid"),
        ({"operation": "merge", "sources": ["A"], "target": "a"}, "tag_operation_invalid"),
        ({"operation": "merge", "sources": [f"t{i}" for i in range(21)], "target": "a"},
         "tag_operation_invalid"),
    ],
)
def test_malformed_operations_are_refused_with_a_code(body, code) -> None:
    with pytest.raises(TagOperationError) as error:
        parse_tag_operation(body)
    assert error.value.code == code


def test_merge_ignores_a_source_that_names_the_target() -> None:
    operation = parse_tag_operation({"operation": "merge", "sources": ["a", "B"], "target": "b"})
    assert operation.source_keys == ("a",)
    assert operation.public() == {"operation": "merge", "sources": ["a"], "target": "b"}
