"""Request-body parsing: the bounded JSON body dependency and field coercion.
"""

from __future__ import annotations

import json
import math
from typing import Annotated, Any
from fastapi import Depends, HTTPException, Request
from starlette.requests import ClientDisconnect
from ..core.legacy_names import upgrade_legacy_names
from ..persistence.token_usage import build_token_usage
from ..persistence.validation import valid_agent
from .deps import app_context


# Bodies from daemons and installers can predate the employee -> user rename.
LEGACY_NAME_ROUTE_PREFIXES = (
    "/api/v1/daemon-node",
    "/api/v1/computer-authorizations",
    # Older supervisors provision computers and patch managed nodes here.
    "/api/v1/admin/daemon-nodes",
    "/api/v1/admin/managed-nodes",
)




def append_json_body_chunk(body: bytearray, chunk: bytes, limit: int) -> None:
    if len(chunk) > limit - len(body):
        raise HTTPException(413, f"JSON request body exceeds the {limit} byte limit.")
    body.extend(chunk)


async def json_body(request: Request) -> dict[str, Any]:
    content_type = (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    )
    if content_type and content_type != "application/json":
        raise HTTPException(415, "Content-Type must be application/json.")
    limit = app_context(request).settings.max_json_body_bytes
    content_length = request.headers.get("content-length", "").strip()
    if content_length:
        try:
            declared_size = int(content_length)
        except ValueError:
            declared_size = 0
        if declared_size > limit:
            raise HTTPException(
                413, f"JSON request body exceeds the {limit} byte limit."
            )
    try:
        body = bytearray()
        async for chunk in request.stream():
            append_json_body_chunk(body, chunk, limit)
    except ClientDisconnect as error:
        raise HTTPException(
            400, "Client disconnected while reading request body."
        ) from error
    if not body:
        return {}
    if not content_type:
        raise HTTPException(415, "Content-Type must be application/json.")
    try:
        value = json.loads(body)
    except json.JSONDecodeError:
        return {}
    if not isinstance(value, dict):
        return {}
    if request.url.path.startswith(LEGACY_NAME_ROUTE_PREFIXES):
        return upgrade_legacy_names(value)
    return value


# Parse the bounded request stream asynchronously, then let FastAPI run the
# synchronous handler (including auth and database transactions) in its pool.
JsonBodyDep = Annotated[dict[str, Any], Depends(json_body)]


def string_field(value: dict[str, Any], key: str) -> str:
    field = value.get(key)
    return field.strip() if isinstance(field, str) else ""


def raw_string_field(value: dict[str, Any], key: str) -> str:
    field = value.get(key)
    return field if isinstance(field, str) else ""


def token_usage_field(
    value: dict[str, Any], key: str = "tokenUsage"
) -> dict[str, Any] | None:
    raw = value.get(key)
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("tokenUsage must be an object.")  # noqa: TRY004 - request validation uses ValueError.
    cache = token_count_field(raw, "cache")
    if "cacheRead" in raw or "cacheWrite" in raw:
        cache_read = token_count_field(raw, "cacheRead")
        cache_write = token_count_field(raw, "cacheWrite")
        if "cache" in raw and cache != cache_read + cache_write:
            raise ValueError("tokenUsage cache must equal cacheRead + cacheWrite.")
    else:
        # A daemon from before the split reports one combined figure.
        cache_read, cache_write = cache, 0
    usage = build_token_usage(
        token_count_field(raw, "input"),
        token_count_field(raw, "output"),
        cache_read,
        cache_write,
    )
    if usage is None:
        raise ValueError("tokenUsage must include at least one reported count.")
    if "total" in raw and token_count_field(raw, "total") != usage["total"]:
        raise ValueError("tokenUsage total must equal input + output + cache.")
    if isinstance(raw.get("source"), str) and raw["source"].strip():
        usage["source"] = raw["source"].strip()
    return usage


def token_count_field(value: dict[str, Any], key: str) -> int:
    raw = value.get(key, 0)
    if (
        isinstance(raw, bool)
        or not isinstance(raw, (int, float))
        or not math.isfinite(raw)
        or raw < 0
    ):
        raise ValueError(f"tokenUsage.{key} must be a non-negative finite number.")
    return int(raw)


def assignment_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        if not isinstance(item, dict):
            continue
        agent = valid_agent(item.get("agent"))
        if not agent:
            continue
        result.append(
            {
                "agent": agent,
                **(
                    {"agentId": item["agentId"]}
                    if isinstance(item.get("agentId"), str) and item["agentId"]
                    else {}
                ),
                **({"role": item["role"]} if role_name(item.get("role")) else {}),
                **(
                    {"brief": item["brief"].strip()[:4000]}
                    if isinstance(item.get("brief"), str) and item["brief"].strip()
                    else {}
                ),
            }
        )
    return result


def participants_for_assignments(
    assignments: Any, assigned_agent: str | None
) -> list[str]:
    agents = [assignment["agent"] for assignment in assignment_list(assignments)]
    if assigned_agent:
        agents.append(assigned_agent)
    return list(dict.fromkeys(["human", *agents]))


def role_name(value: Any) -> str | None:
    return (
        value
        if value in ("implementer", "reviewer", "planner", "tester", "fixer")
        else None
    )
