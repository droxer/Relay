"""Request schemas for the busiest write endpoints.

Each schema names the JSON fields its route reads, so the OpenAPI document
shows the body and the route reads typed attributes instead of raw dict keys.

They are wire-compatible with the hand parsing they replace, which was
permissive: a field of the wrong type was read as absent, never refused. The
field types here keep that rule (``TrimmedStr`` reads a non-string as
``None``), unknown fields are allowed, and the original body stays available
through ``as_dict()`` because the task services still judge it with their
``"field" in body`` rules. The only refusals a schema makes are the ones its
route made before it touched any record, raised as the same ``HTTPException``
in the same order.

Routes parse through ``request_body`` (a dependency) or ``parse_request_body``
rather than declaring the model as a FastAPI body parameter: FastAPI's own
validation would answer 422 and bypass ``json_body``'s size limit and
content-type rule. ``openapi_body`` publishes the schema instead.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Annotated, Any, TypeVar

from fastapi import Depends, HTTPException, Request
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    PrivateAttr,
    ValidationError,
    ValidatorFunctionWrapHandler,
    WithJsonSchema,
    model_validator,
)

from .bodies import json_body


def _trimmed(value: Any) -> str | None:
    """``string_field``: a string is stripped, anything else reads as absent."""
    return value.strip() if isinstance(value, str) else None


def _verbatim(value: Any) -> str | None:
    """``raw_string_field``: a string as sent, anything else reads as absent."""
    return value if isinstance(value, str) else None


def _list(value: Any) -> list[Any] | None:
    return value if isinstance(value, list) else None


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


TrimmedStr = Annotated[str | None, BeforeValidator(_trimmed)]
VerbatimStr = Annotated[str | None, BeforeValidator(_verbatim)]
LenientList = Annotated[list[Any] | None, BeforeValidator(_list)]
LenientBool = Annotated[bool | None, BeforeValidator(_bool)]
# Read verbatim and checked by the schema's own rule, so a wrong type answers
# the route's original 400 rather than pydantic's message.
CheckedStr = Annotated[Any, WithJsonSchema({"anyOf": [{"type": "string"}, {"type": "null"}]})]
CheckedStrList = Annotated[
    Any,
    WithJsonSchema({"anyOf": [{"type": "array", "items": {"type": "string"}}, {"type": "null"}]}),
]
AssignmentList = Annotated[
    list[Any] | None,
    BeforeValidator(_list),
    WithJsonSchema(
        {
            "anyOf": [
                {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "agent": {"type": "string"},
                            "agentId": {"type": "string"},
                            "role": {"type": "string"},
                            "brief": {"type": "string"},
                        },
                    },
                },
                {"type": "null"},
            ]
        }
    ),
]


class RequestSchema(BaseModel):
    """A permissive request body that remembers what was sent."""

    # No ``populate_by_name``: only the wire (alias) names may set a field, so
    # a snake_case key a client sends stays an unknown, ignored field.
    model_config = ConfigDict(extra="allow", frozen=True)

    _raw: dict[str, Any] = PrivateAttr(default_factory=dict)

    @model_validator(mode="wrap")
    @classmethod
    def _keep_raw(cls, data: Any, handler: ValidatorFunctionWrapHandler) -> Any:
        model = handler(data)
        if isinstance(model, RequestSchema) and isinstance(data, dict):
            model._raw = dict(data)
        return model

    def as_dict(self) -> dict[str, Any]:
        """The body exactly as sent, for rules that read raw fields."""
        return dict(self._raw)

    def is_set(self, field_name: str) -> bool:
        """Whether the body names the field at all, null included."""
        return field_name in self.model_fields_set


SchemaT = TypeVar("SchemaT", bound=RequestSchema)

INVALID_BODY_DETAIL = "Request body is invalid."


def parse_schema(schema: type[SchemaT], raw: dict[str, Any]) -> SchemaT:
    """Validate a decoded body; a schema refusal is an ``HTTPException``."""
    try:
        return schema.model_validate(raw)
    except ValidationError as error:
        # The lenient field types cannot fail; this guards a future strict one.
        raise HTTPException(400, INVALID_BODY_DETAIL) from error


async def parse_request_body(request: Request, schema: type[SchemaT]) -> SchemaT:
    """``json_body`` (size limit, content type) and then the schema."""
    return parse_schema(schema, await json_body(request))


def request_body(schema: type[SchemaT]) -> Callable[[Request], Awaitable[SchemaT]]:
    """A dependency that reads the bounded body into ``schema``."""

    async def dependency(request: Request) -> SchemaT:
        return await parse_request_body(request, schema)

    return dependency


def openapi_body(schema: type[RequestSchema]) -> dict[str, Any]:
    """``openapi_extra`` publishing ``schema`` as the JSON request body."""
    return {
        "requestBody": {
            "required": False,
            "content": {"application/json": {"schema": schema.model_json_schema()}},
        }
    }


class _TaskFields(RequestSchema):
    """What both a task create and a task PATCH may carry."""

    title: TrimmedStr = None
    description: VerbatimStr = None
    priority: TrimmedStr = None
    status: TrimmedStr = None
    due_date: Annotated[CheckedStr, Field(alias="dueDate")] = None
    assignee_user_id: TrimmedStr = Field(None, alias="assigneeUserId")
    # The legacy snake_case spelling the assignee rule still honours.
    assignee_user_id_legacy: TrimmedStr = Field(None, alias="assignee_user_id")
    project_id: TrimmedStr = Field(None, alias="projectId")
    assigned_agent_id: TrimmedStr = Field(None, alias="assignedAgentId")
    assigned_team_id: TrimmedStr = Field(None, alias="assignedTeamId")
    acceptance_policy: CheckedStr = Field(None, alias="acceptancePolicy")
    collaboration_style: CheckedStr = Field(None, alias="collaborationStyle")
    is_routine: LenientBool = Field(None, alias="isRoutine")
    routine_triggers: LenientList = Field(None, alias="routineTriggers")
    routine_state: TrimmedStr = Field(None, alias="routineState")

    def names_assignee(self) -> bool:
        return self.is_set("assignee_user_id") or self.is_set("assignee_user_id_legacy")


class TaskCreateBody(_TaskFields):
    """``POST /tasks``."""

    task_goal: TrimmedStr = Field(None, alias="taskGoal")
    owner_user_id: TrimmedStr = Field(None, alias="ownerUserId")
    user_id: TrimmedStr = Field(None, alias="userId")
    create_session: LenientBool = Field(None, alias="createSession")
    assignments: AssignmentList = None
    workspace_path: TrimmedStr = Field(None, alias="workspacePath")

    def task_title(self) -> str:
        """The title, falling back to the legacy ``taskGoal`` spelling."""
        return self.title or self.task_goal or ""


class TaskPatchBody(_TaskFields):
    """``PATCH /tasks/{id}``: only the fields it names change."""

    action: TrimmedStr = None
    blocker_reason: TrimmedStr = Field(None, alias="blockerReason")


class TaskStartBody(RequestSchema):
    """``POST /tasks/{id}/runs``."""

    assignments: AssignmentList = None
    # Read-only: naming any agent here is refused by the start service.
    agent: Annotated[Any, WithJsonSchema({"type": "string"})] = None

    def requests_agent(self) -> bool:
        return self.agent is not None


class ThreadCreateBody(RequestSchema):
    """``POST /threads``."""

    task_goal: TrimmedStr = Field(None, alias="taskGoal")
    assignments: AssignmentList = None
    workspace_path: TrimmedStr = Field(None, alias="workspacePath")
    daemon_node_id: TrimmedStr = Field(None, alias="daemonNodeId")
    daemon_node_id_legacy: TrimmedStr = Field(None, alias="daemon_node_id")
    task_id: VerbatimStr = Field(None, alias="taskId")
    project_id: TrimmedStr = Field(None, alias="projectId")
    owner_user_id: TrimmedStr = Field(None, alias="ownerUserId")
    user_id: TrimmedStr = Field(None, alias="userId")

    def node_id(self) -> str:
        return self.daemon_node_id or self.daemon_node_id_legacy or ""


MESSAGE_PURPOSES: frozenset[str] = frozenset({"accomplish", "discuss", "review"})
ADDRESS_AGENT_IDS_DETAIL = "addressAgentIds must be a list of agent ids."


class ThreadMessageBody(RequestSchema):
    """``POST /threads/{id}/messages``.

    The checks the route made before reading the thread run here, in the same
    order and with the same answers; the rest (mentions, the team/agent
    conflict, the style) need the thread and stay in the route.
    """

    text: TrimmedStr = None
    intent: Annotated[
        TrimmedStr,
        WithJsonSchema({"anyOf": [{"enum": sorted(MESSAGE_PURPOSES)}, {"type": "null"}]}),
    ] = None
    question_id: CheckedStr = Field(None, alias="questionId")
    address_agent_ids: CheckedStrList = Field(None, alias="addressAgentIds")
    # The singular field the chat gateway still sends.
    address_agent_id: TrimmedStr = Field(None, alias="addressAgentId")
    address_team_id: TrimmedStr = Field(None, alias="addressTeamId")
    idempotency_key: TrimmedStr = Field(None, alias="idempotencyKey")
    user_message_id: TrimmedStr = Field(None, alias="userMessageId")
    style: Annotated[Any, WithJsonSchema({"type": "string"})] = None

    @model_validator(mode="after")
    def _check_shape(self) -> ThreadMessageBody:
        if not self.text:
            raise HTTPException(400, "text is required.")
        if self.purpose() not in MESSAGE_PURPOSES:
            raise HTTPException(400, "intent must be accomplish, discuss, or review.")
        question_id = self.question_id
        if question_id is not None and (not isinstance(question_id, str) or not question_id):
            raise HTTPException(400, "questionId must be a question id.")
        if question_id and self.purpose() != "accomplish":
            # An answer resumes the task; a discussion must not.
            raise HTTPException(
                400,
                {
                    "code": "answer_requires_accomplish",
                    "message": "An answer is sent with intent accomplish.",
                },
            )
        raw = self.address_agent_ids
        if raw is not None and not (
            isinstance(raw, list) and all(isinstance(item, str) and item for item in raw)
        ):
            raise HTTPException(400, ADDRESS_AGENT_IDS_DETAIL)
        return self

    def message_text(self) -> str:
        return self.text or ""

    def purpose(self) -> str:
        return self.intent or "accomplish"

    def answered_question_id(self) -> str | None:
        return self.question_id or None

    def supplied_address_agent_ids(self) -> tuple[str, ...]:
        """The addressed agents, accepting the singular legacy field."""
        if isinstance(self.address_agent_ids, list):
            return tuple(dict.fromkeys(self.address_agent_ids))
        return (self.address_agent_id,) if self.address_agent_id else ()


ThreadMessageBodyDep = Annotated[ThreadMessageBody, Depends(request_body(ThreadMessageBody))]
TaskCreateBodyDep = Annotated[TaskCreateBody, Depends(request_body(TaskCreateBody))]
TaskPatchBodyDep = Annotated[TaskPatchBody, Depends(request_body(TaskPatchBody))]
ThreadCreateBodyDep = Annotated[ThreadCreateBody, Depends(request_body(ThreadCreateBody))]
