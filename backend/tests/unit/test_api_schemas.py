"""The request schemas stay wire-compatible with the hand parsing they replace."""
from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi import HTTPException

from relay.api.bodies import string_field
from relay.api.schemas import (
    INVALID_BODY_DETAIL,
    TaskCreateBody,
    TaskPatchBody,
    TaskStartBody,
    ThreadCreateBody,
    ThreadMessageBody,
    openapi_body,
    parse_schema,
)


def _refusal(body: dict[str, Any]) -> HTTPException:
    with pytest.raises(HTTPException) as caught:
        parse_schema(ThreadMessageBody, body)
    return caught.value


def test_patch_distinguishes_an_absent_field_from_a_null_one() -> None:
    absent = parse_schema(TaskPatchBody, {"title": "x"})
    cleared = parse_schema(TaskPatchBody, {"assigneeUserId": None, "projectId": None})

    assert not absent.is_set("assignee_user_id")
    assert not absent.is_set("project_id")
    assert not absent.names_assignee()
    assert cleared.is_set("assignee_user_id")
    assert cleared.is_set("project_id")
    assert cleared.names_assignee()
    assert "assigneeUserId" not in absent.as_dict()
    assert cleared.as_dict() == {"assigneeUserId": None, "projectId": None}


def test_patch_honours_the_legacy_assignee_spelling() -> None:
    body = parse_schema(TaskPatchBody, {"assignee_user_id": "u-1"})

    assert body.names_assignee()
    assert body.assignee_user_id is None
    assert body.assignee_user_id_legacy == "u-1"


def test_unknown_fields_are_kept_and_never_refused() -> None:
    raw = {"title": "t", "somethingNew": {"nested": [1, 2]}, "assignedAgent": "claude"}

    body = parse_schema(TaskCreateBody, raw)

    # The services still refuse assignedAgent by name; the schema keeps it.
    assert body.as_dict() == raw
    assert body.model_extra == {"somethingNew": {"nested": [1, 2]}, "assignedAgent": "claude"}


def test_snake_case_keys_do_not_populate_camel_case_fields() -> None:
    body = parse_schema(TaskCreateBody, {"task_goal": "goal", "project_id": "p-1"})

    assert body.task_title() == ""
    assert body.project_id is None


@pytest.mark.parametrize(
    "raw",
    [
        {"title": 5, "taskGoal": ["x"], "priority": 3, "status": {}, "projectId": 7},
        {"assignments": "not-a-list", "createSession": "yes", "isRoutine": "true"},
        {"description": 12, "routineTriggers": {}, "workspacePath": None},
    ],
)
def test_wrongly_typed_task_fields_read_as_absent_like_the_old_helpers(raw: dict[str, Any]) -> None:
    body = parse_schema(TaskCreateBody, raw)

    assert body.task_title() == (string_field(raw, "title") or string_field(raw, "taskGoal"))
    assert (body.project_id or "") == string_field(raw, "projectId")
    assert body.assignments is None
    # The raw body still reaches the services untouched, so their own type
    # rules (and the exact detail they answer) are unchanged.
    assert body.as_dict() == raw


def test_strings_are_trimmed_like_string_field() -> None:
    body = parse_schema(TaskCreateBody, {"title": "  Ship it  ", "projectId": "   "})

    assert body.task_title() == "Ship it"
    assert body.project_id == ""


def test_task_start_reads_the_raw_assignments_and_the_read_only_agent() -> None:
    items = [{"agentId": "a-1", "agent": "claude"}, "junk"]

    body = parse_schema(TaskStartBody, {"assignments": items, "agent": "codex"})
    empty = parse_schema(TaskStartBody, {"agent": None})

    assert body.assignments == items
    assert body.requests_agent()
    assert not empty.requests_agent()


def test_thread_create_keeps_the_task_id_verbatim_and_the_legacy_node_field() -> None:
    body = parse_schema(
        ThreadCreateBody, {"taskGoal": " g ", "taskId": " t-1 ", "daemon_node_id": "n-1"}
    )
    bare = parse_schema(ThreadCreateBody, {"taskGoal": "g", "taskId": 4})

    assert body.task_goal == "g"
    assert body.task_id == " t-1 "
    assert body.node_id() == "n-1"
    assert bare.task_id is None
    assert bare.node_id() == ""
    assert not bare.is_set("assignments")


@pytest.mark.parametrize(
    ("raw", "detail"),
    [
        ({}, "text is required."),
        ({"text": 5}, "text is required."),
        # The text check comes first, as it did in the route.
        ({"text": "  ", "questionId": 3}, "text is required."),
        ({"text": "hi", "intent": "chat"}, "intent must be accomplish, discuss, or review."),
        ({"text": "hi", "questionId": 3}, "questionId must be a question id."),
        ({"text": "hi", "questionId": ""}, "questionId must be a question id."),
        (
            {"text": "hi", "intent": "discuss", "questionId": "q-1"},
            {
                "code": "answer_requires_accomplish",
                "message": "An answer is sent with intent accomplish.",
            },
        ),
        ({"text": "hi", "addressAgentIds": "a-1"}, "addressAgentIds must be a list of agent ids."),
        ({"text": "hi", "addressAgentIds": ["a-1", ""]}, "addressAgentIds must be a list of agent ids."),
        ({"text": "hi", "addressAgentIds": [1]}, "addressAgentIds must be a list of agent ids."),
    ],
)
def test_message_refusals_keep_their_status_and_detail(raw: dict[str, Any], detail: Any) -> None:
    error = _refusal(raw)

    assert error.status_code == 400
    assert error.detail == detail


def test_message_reads_addressing_like_the_route_did() -> None:
    listed = parse_schema(
        ThreadMessageBody,
        {"text": " hi ", "addressAgentIds": ["a", "b", "a"], "addressAgentId": "c"},
    )
    single = parse_schema(ThreadMessageBody, {"text": "hi", "addressAgentId": " c "})
    empty_list = parse_schema(ThreadMessageBody, {"text": "hi", "addressAgentIds": []})

    assert listed.message_text() == "hi"
    assert listed.purpose() == "accomplish"
    assert listed.supplied_address_agent_ids() == ("a", "b")
    assert single.supplied_address_agent_ids() == ("c",)
    assert empty_list.supplied_address_agent_ids() == ()


def test_message_answer_and_optional_fields() -> None:
    body = parse_schema(
        ThreadMessageBody,
        {"text": "yes", "intent": "", "questionId": "q-1", "idempotencyKey": 9, "style": "solo"},
    )

    assert body.purpose() == "accomplish"
    assert body.answered_question_id() == "q-1"
    assert body.idempotency_key is None
    assert body.style == "solo"


def test_a_schema_validation_error_maps_to_a_400() -> None:
    with pytest.raises(HTTPException) as caught:
        parse_schema(TaskPatchBody, "not an object")  # type: ignore[arg-type]

    assert caught.value.status_code == 400
    assert caught.value.detail == INVALID_BODY_DETAIL


@pytest.mark.parametrize(
    "schema", [TaskCreateBody, TaskPatchBody, TaskStartBody, ThreadCreateBody, ThreadMessageBody]
)
def test_openapi_body_is_self_contained(schema: Any) -> None:
    extra = openapi_body(schema)
    published = extra["requestBody"]["content"]["application/json"]["schema"]

    # A nested $defs would point outside the operation in the OpenAPI document.
    assert "$defs" not in json.dumps(published)
    assert published["additionalProperties"] is True
