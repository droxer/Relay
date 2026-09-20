from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

AgentName = Literal["claude", "pi", "codex", "kimi"]
SessionStatus = Literal[
    "running", "waiting_for_human", "completed", "failed", "cancelled"
]
TaskPriority = Literal["low", "normal", "high"]
TaskStatus = Literal[
    "backlog", "assigned", "running", "waiting_for_human", "review", "done", "blocked"
]
TaskRoutineType = Literal["task", "job"]
TaskRoutineCadence = Literal["daily", "weekly", "monthly", "custom"]
SandboxStatus = Literal["provisioning", "ready", "running", "stopped", "failed"]
RunStatus = Literal["running", "completed", "failed", "cancelled"]
CommandStatus = Literal["queued", "dispatched", "completed", "failed", "cancelled"]

AGENT_NAMES: tuple[str, ...] = ("claude", "pi", "codex", "kimi")
AGENT_ROLES: tuple[str, ...] = ("implementer", "reviewer", "planner", "tester", "fixer")
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
    sandbox_id: str
    employee_id: str | None = None
    token: str
    workspace_path: str | None = None
    workspace_id: str | None = None
    sandbox_mode: Literal["none", "boxlite"] | None = None
    protocol_version: int
    supported_agents: list[AgentName] = []
    executor_capabilities: list[dict[str, Any]] | None = None
    agent_health: dict[str, dict[str, Any]] | None = None
    max_concurrent_runs: int | None = None
    status: Literal["ready", "busy", "stopped"] = "ready"
