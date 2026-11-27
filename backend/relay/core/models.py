from __future__ import annotations

from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field

from .client_version import CLIENT_VERSION_MAX_LENGTH, CLIENT_VERSION_PATTERN

AgentName = Literal["claude", "pi", "codex", "opencode", "antigravity"]
# Older daemons can register and finish reporting runs they already own.
DaemonWireAgentName = Literal[AgentName, "kimi"]
DAEMON_WIRE_AGENT_NAMES = get_args(DaemonWireAgentName)
SessionStatus = Literal[
    "running", "waiting_for_human", "completed", "failed", "cancelled"
]
TaskPriority = Literal["low", "normal", "high"]
TaskStatus = Literal[
    "backlog", "assigned", "queued", "running", "waiting_for_human", "review", "done", "blocked", "cancelled"
]
SandboxStatus = Literal["provisioning", "ready", "running", "stopped", "failed"]

AGENT_NAMES: tuple[str, ...] = get_args(AgentName)
ENGINEER_SPECIALTY_ROLES = ("frontend_engineer", "backend_engineer", "fullstack_engineer")
# Offered in stage order (`ROLE_STAGE` in collaboration/styles.py), the order a
# Pipeline round takes them in.
AGENT_ROLES: tuple[str, ...] = (
    "researcher",
    "product_manager",
    "data",
    "planner",
    "designer",
    "implementer",
    *ENGINEER_SPECIALTY_ROLES,
    "fixer",
    "tester",
    "security",
    "performance",
    "writer",
    "devops",
    "operations",
    "reviewer",
)
AGENT_ROLE_LEVELS: tuple[str, ...] = ("junior", "senior")
AgentRoleLevel = Literal["junior", "senior"]
# Version 2 adds ordered run.output.batch delivery. Keep version 1 accepted so
# existing daemons can finish upgrading with their legacy run.output events.
DAEMON_NODE_PROTOCOL_VERSION = 2
DAEMON_NODE_SUPPORTED_PROTOCOL_VERSIONS = (2, 1)


def to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part[:1].upper() + part[1:] for part in parts[1:])


class RelayModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="allow",
        populate_by_name=True,
        validate_by_alias=True,
        validate_by_name=True,
    )

    def relay_dump(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True)


class RuntimeRefreshAcknowledgement(RelayModel):
    command_id: str
    lease_id: str


class DaemonNodeRegistration(RelayModel):
    runtime_refresh_commands: list[RuntimeRefreshAcknowledgement] = Field(default_factory=list, max_length=50)
    # Runs a restarted daemon admitted before it crashed and will not resume.
    journaled_command_ids: list[str] = Field(default_factory=list, max_length=1000)
    sandbox_id: str
    user_id: str | None = None
    token: str
    workspace_path: str | None = None
    workspace_id: str | None = None
    sandbox_mode: Literal["none", "boxlite"] | None = None
    # Release identity is optional for older daemons; unrelated to wire version.
    client_version: str | None = Field(
        default=None, max_length=CLIENT_VERSION_MAX_LENGTH, pattern=CLIENT_VERSION_PATTERN,
    )
    protocol_version: int
    supported_agents: list[DaemonWireAgentName] = []
    executor_capabilities: list[dict[str, Any]] | None = None
    agent_health: dict[str, dict[str, Any]] | None = None
    max_concurrent_runs: int | None = None
    status: Literal["ready", "busy", "stopped"] = "ready"
