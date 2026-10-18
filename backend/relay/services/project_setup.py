"""Agent-drafted project setup: an agent proposes, the owner applies.

A setup round is an ordinary daemon run in the project's room. Its agent reads
the owner's intent and the agents on the project's computer, then writes a
proposal file the daemon reports back. Nothing here applies a proposal: the
owner reviews it and applies it through the normal project PATCH, so every
roster rule still runs at the moment it takes effect.

The shape checks are pure (the daemon registry records proposals without the
agent stores); store-backed checks happen when the proposal is read.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from ..core.ids import new_relay_id, now_iso
from ..core.models import AGENT_ROLES
from .project_runtime import agent_on_project_computer

PROJECT_SETUP_CONTRACT = {"name": "relay.project.setup", "version": 1}
SETUP_INTENT_MAX_LENGTH = 4_000
SETUP_CANDIDATES_MAX = 32
SETUP_RESOLUTIONS = frozenset({"applied", "dismissed"})
_INSTRUCTIONS_EXCERPT = 300
_TERMINAL_SESSION_STATUSES = frozenset({"completed", "failed", "cancelled"})
# How long a draft may sit without a thread before it counts as abandoned:
# dispatch records the thread within one request, so anything older crashed.
_DISPATCH_GRACE = timedelta(minutes=2)



class ProjectSetupError(ValueError):
    def __init__(self, code: str, *, status: int = 409):
        self.code = code
        self.status = status
        super().__init__(code)


def setup_intent(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProjectSetupError("project_setup_intent_required", status=400)
    normalized = value.strip()
    if len(normalized) > SETUP_INTENT_MAX_LENGTH:
        raise ProjectSetupError("project_setup_intent_too_long", status=400)
    return normalized


def setup_candidates(
    project: dict[str, Any], *, agent_store: Any, placement_store: Any
) -> list[dict[str, Any]]:
    """The owner's enabled agents on the project's computer — the only agents
    a proposal may staff, and what the setup agent is told it can choose from."""
    candidates = []
    for agent in agent_store.list_agents(
        supervisor_user_id=project["ownerUserId"]
    ):
        if not agent.get("enabled", True):
            continue
        if not agent_on_project_computer(project, agent["id"], placement_store):
            continue
        instructions = (agent.get("instructions") or "").strip()
        candidates.append(
            {
                "agentId": agent["id"],
                "name": agent.get("displayName") or agent["id"],
                "executorKind": agent.get("executorKind"),
                **({"defaultRole": agent["defaultRole"]} if agent.get("defaultRole") else {}),
                **(
                    {"personality": instructions[:_INSTRUCTIONS_EXCERPT]}
                    if instructions
                    else {}
                ),
            }
        )
    return candidates[:SETUP_CANDIDATES_MAX]


def choose_setup_agent(
    candidates: list[dict[str, Any]],
    requested_agent_id: Any,
    *,
    lead_agent_id: str | None = None,
) -> str:
    """The requested agent when it is a candidate; otherwise the project's
    lead (who knows the work when an existing crew is refined), then the
    first planner, then the first candidate."""
    if not candidates:
        raise ProjectSetupError("project_setup_no_agents")
    if requested_agent_id is not None:
        if not isinstance(requested_agent_id, str) or requested_agent_id not in {
            candidate["agentId"] for candidate in candidates
        }:
            raise ProjectSetupError("project_setup_agent_unavailable", status=400)
        return requested_agent_id
    if lead_agent_id is not None and lead_agent_id in {
        candidate["agentId"] for candidate in candidates
    }:
        return lead_agent_id
    planner = next(
        (c for c in candidates if c.get("defaultRole") == "planner"), None
    )
    return (planner or candidates[0])["agentId"]


def setup_manifest_block(
    *,
    intent: str,
    candidates: list[dict[str, Any]],
    previous_proposal: dict[str, Any] | None,
    draft_id: str,
) -> dict[str, Any]:
    """What the round manifest carries so the registry can brief the agent."""
    return {
        "contract": PROJECT_SETUP_CONTRACT,
        "draftId": draft_id,
        "intent": intent,
        "candidates": candidates,
        "roles": list(AGENT_ROLES),
        **({"previousProposal": previous_proposal} if previous_proposal else {}),
    }


def setup_task_goal(intent: str, *, revising: bool) -> str:
    if revising:
        return f"Revise the project setup proposal: {intent}"
    return f"Set up this project: {intent}"


def drafting_setup(
    *,
    intent: str,
    agent_id: str,
    thread_id: str | None,
    previous: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "state": "drafting",
        "draftId": new_relay_id("setup"),
        "intent": intent,
        "agentId": agent_id,
        "threadId": thread_id,
        "startedAt": now_iso(),
        **(
            {"proposal": previous["proposal"]}
            if previous and previous.get("proposal")
            else {}
        ),
    }


def setup_in_progress(setup: dict[str, Any] | None, session_store: Any) -> bool:
    """True while a drafted setup's thread is still running.

    A draft whose dispatch never produced a thread, or whose thread already
    ended without a recorded result, must not block a fresh attempt.
    """
    if not setup or setup.get("state") != "drafting":
        return False
    if not setup.get("threadId"):
        # Still dispatching: a second start now would race the first.
        return _recent(setup.get("startedAt"))
    try:
        session = session_store.get_session(setup["threadId"])
    except KeyError:
        return False
    return session.get("status") not in _TERMINAL_SESSION_STATUSES


def _recent(timestamp: Any) -> bool:
    if not isinstance(timestamp, str):
        return False
    try:
        started = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    return datetime.now(UTC) - started < _DISPATCH_GRACE


def resolved_setup(current: dict[str, Any] | None, resolution: Any) -> dict[str, Any]:
    if resolution not in SETUP_RESOLUTIONS:
        raise ProjectSetupError("project_setup_resolution_invalid", status=400)
    if not current or current.get("state") in SETUP_RESOLUTIONS:
        raise ProjectSetupError("project_setup_not_open")
    if resolution == "applied" and current.get("state") != "proposed":
        raise ProjectSetupError("project_setup_not_proposed")
    return {**current, "state": resolution, "resolvedAt": now_iso()}


def annotate_setup(
    project: dict[str, Any], *, agent_store: Any, placement_store: Any
) -> dict[str, Any] | None:
    """The project's setup with each proposed member's current eligibility.

    A proposal is advice recorded at one moment; agents can be disabled or
    moved since. The issue codes let the owner see what Apply would refuse.
    """
    setup = project.get("setup")
    if not setup or not (setup.get("proposal") or {}).get("members"):
        return setup
    proposal = setup["proposal"]
    members = [
        {
            **member,
            **(
                {"issue": issue}
                if (issue := _member_issue(project, member["agentId"], agent_store, placement_store))
                else {}
            ),
        }
        for member in proposal["members"]
    ]
    return {**setup, "proposal": {**proposal, "members": members}}


def _member_issue(
    project: dict[str, Any], agent_id: str, agent_store: Any, placement_store: Any
) -> str | None:
    agent = agent_store.get_agent(agent_id)
    if not agent or agent.get("deletedAt"):
        return "agent_not_found"
    if agent.get("supervisorUserId") != project["ownerUserId"]:
        return "agent_wrong_owner"
    if not agent.get("enabled", True):
        return "agent_disabled"
    if not agent_on_project_computer(project, agent_id, placement_store):
        return "agent_off_computer"
    return None
