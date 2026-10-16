from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter
from fastapi.routing import APIRoute

API_VERSION = "v1"
API_PREFIX = f"/api/{API_VERSION}"
API_DOCS_PATH = "/api/docs"
API_OPENAPI_PATH = "/api/openapi.json"
API_REDOC_PATH = "/api/redoc"
WEB_UI_ROUTE_ROOTS = frozenset(
    {
        "admin",
        "agents",
        "automations",
        "backlog",
        "channels",
        "computer",
        "forgot-password",
        "issues",
        "join",
        "login",
        "projects",
        "reset-password",
        "routines",
        "settings",
        "skills",
        "tasks",
        "teams",
        "threads",
        "waitlist",
    }
)


# Chat channels: the gateway's internal API and the admin surface that
# configures it. They are published together or not at all.
CHANNEL_ROUTE_PREFIXES = ("/internal/chat/", "/admin/chat-integrations")


def is_channel_route(path: str) -> bool:
    """True for a route that belongs to the chat channels feature."""
    return path.startswith(CHANNEL_ROUTE_PREFIXES)


# The waitlist: a public, unauthenticated write path, so it is published only
# when an operator opts in.
WAITLIST_ROUTE_PREFIXES = ("/waitlist", "/admin/waitlist")


def is_waitlist_route(path: str) -> bool:
    """True for a route that belongs to the waitlist feature."""
    return path.startswith(WAITLIST_ROUTE_PREFIXES)


@dataclass
class ApiRouterGroups:
    public: APIRouter
    admin: APIRouter
    internal_chat: APIRouter
    daemon: APIRouter


def api_router_groups() -> ApiRouterGroups:
    return ApiRouterGroups(
        public=APIRouter(),
        admin=APIRouter(),
        internal_chat=APIRouter(),
        daemon=APIRouter(),
    )


def _tag_for_path(path: str) -> str:
    parts = [part for part in path.split("/") if part]
    if parts[:2] == ["internal", "chat"]:
        return "internal-chat"
    if parts and parts[0] == "admin":
        return f"admin-{parts[1]}" if len(parts) > 1 else "admin"
    return parts[0] if parts else "api"


def _api_group(groups: ApiRouterGroups, path: str) -> APIRouter:
    if path.startswith("/admin/"):
        return groups.admin
    if path.startswith("/internal/chat/"):
        return groups.internal_chat
    if path.startswith(("/daemon-nodes", "/daemon-node-")):
        return groups.daemon
    return groups.public


def include_api_router(
    groups: ApiRouterGroups,
    router: APIRouter,
    *,
    channels_enabled: bool = True,
    waitlist_enabled: bool = True,
) -> None:
    """Publish a domain router under the canonical versioned API prefix.

    With channels or the waitlist disabled, their routes are left unpublished:
    they answer 404 and stay out of the OpenAPI document, as if the feature
    were not built.
    """
    for route in router.routes:
        if not isinstance(route, APIRoute):
            continue
        if not channels_enabled and is_channel_route(route.path):
            continue
        if not waitlist_enabled and is_waitlist_route(route.path):
            continue
        _api_group(groups, route.path).add_api_route(
            f"{API_PREFIX}{route.path}",
            route.endpoint,
            methods=route.methods or set(),
            response_model=route.response_model,
            status_code=route.status_code,
            tags=[_tag_for_path(route.path)],
            dependencies=route.dependencies,
            summary=route.summary,
            description=route.description,
            response_description=route.response_description,
            responses=route.responses,
            deprecated=route.deprecated,
            operation_id=route.operation_id,
            response_class=route.response_class,
            name=route.name,
            openapi_extra=route.openapi_extra,
        )
