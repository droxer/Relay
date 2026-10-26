"""Pure folding of an agent-drafted project setup run into the project record.

The daemon registry applies it when a setup run finishes; the setup service
that starts the run lives in ``project_setup``.
"""

from __future__ import annotations

import re
from typing import Any

from ..core.ids import now_iso
from ..core.models import AGENT_ROLES


SETUP_TASKS_MAX = 8
SETUP_MODES = frozenset({"setup", "plan"})
# A proposed task's handle within its proposal: what ``after`` names and what
# the owner selects when applying only some of the tasks.
_TASK_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
# An existing task is named by its id, which is a UUID.
_TASK_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


# Caps mirror project_catalog; a proposal is held to the limits the PATCH that
# applies it will enforce, so an accepted proposal never fails on length.
_LIMITS = {
    "name": 120,
    "goal": 280,
    "description": 4_000,
    "context": 8_000,
    "responsibilities": 4_000,
    "instructions": 8_000,
    "rationale": 2_000,
    "taskTitle": 200,
    "taskDescription": 4_000,
}


_MEMBERS_MAX = 32


def completed_setup(
    current: dict[str, Any] | None, raw_proposal: Any, *, exit_code: int
) -> dict[str, Any] | None:
    """Fold a finished setup run into the project's setup record.

    Returns None when the project's setup has moved on (resolved, or no round
    is drafting), so a late result never reopens a decided setup.
    """
    if not current or current.get("state") != "drafting":
        return None
    mode = current.get("mode", "setup")
    proposal = normalize_setup_proposal(raw_proposal, mode=mode) if exit_code == 0 else None
    timestamp = now_iso()
    if proposal is None:
        return {
            **current,
            "state": "failed",
            "error": "setup_run_failed" if exit_code != 0 else "setup_no_proposal",
            "finishedAt": timestamp,
        }
    return {
        **{key: value for key, value in current.items() if key != "error"},
        "state": "proposed",
        "proposal": proposal,
        "finishedAt": timestamp,
    }


def normalize_setup_proposal(raw: Any, *, mode: str = "setup") -> dict[str, Any] | None:
    """Hold an agent-written proposal to the shape the PATCH accepts.

    Lenient where an agent is merely sloppy (an unknown role becomes
    implementer, overlong text is clipped, a member without responsibilities
    is dropped) and empty-handed where there is nothing usable. A plan
    proposal keeps only its tasks and rationale: planning never restaffs.
    """
    if not isinstance(raw, dict):
        return None
    if mode == "plan":
        tasks = _proposal_tasks(raw.get("tasks"))
        if not tasks:
            return None
        rationale = _clip(raw.get("rationale"), _LIMITS["rationale"])
        return {"tasks": tasks, **({"rationale": rationale} if rationale else {})}
    proposal: dict[str, Any] = {}
    for field in ("name", "goal", "description", "context", "rationale"):
        text = _clip(raw.get(field), _LIMITS[field])
        if text:
            proposal[field] = text
    members = _proposal_members(raw.get("members"))
    if members:
        proposal["members"] = members
        lead = raw.get("leadAgentId")
        member_ids = [member["agentId"] for member in members]
        proposal["leadAgentId"] = lead if lead in member_ids else member_ids[0]
    tasks = _proposal_tasks(raw.get("tasks") or raw.get("firstTasks"))
    if tasks:
        proposal["tasks"] = tasks
    if not (members or proposal.get("goal") or proposal.get("context")):
        return None
    return proposal


def _proposal_members(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    members: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        agent_id = item.get("agentId")
        responsibilities = _clip(item.get("responsibilities"), _LIMITS["responsibilities"])
        if not isinstance(agent_id, str) or not agent_id.strip() or not responsibilities:
            continue
        agent_id = agent_id.strip()
        if agent_id in seen:
            continue
        seen.add(agent_id)
        role = item.get("role") if item.get("role") in AGENT_ROLES else "implementer"
        instructions = _clip(item.get("instructions"), _LIMITS["instructions"])
        members.append(
            {
                "agentId": agent_id,
                "role": role,
                "responsibilities": responsibilities,
                **({"instructions": instructions} if instructions else {}),
            }
        )
        if len(members) == _MEMBERS_MAX:
            break
    return members


def _proposal_tasks(raw: Any) -> list[dict[str, Any]]:
    """Each task gets a unique ``key``; ``after`` keeps only keys of earlier
    tasks (so a proposal is acyclic by construction) and ``afterTaskIds``
    the other references, which name existing tasks and are checked against
    the project when the tasks are applied."""
    if not isinstance(raw, list):
        return []
    tasks: list[dict[str, Any]] = []
    keys: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = _clip(item.get("title"), _LIMITS["taskTitle"])
        if not title:
            continue
        description = _clip(item.get("description"), _LIMITS["taskDescription"])
        criteria = item.get("acceptanceCriteria")
        if isinstance(criteria, list):
            lines = [f"- {text}" for c in criteria if (text := _clip(c, 500))]
            if lines:
                description = "\n".join(
                    filter(None, [description, "Acceptance criteria:", *lines])
                )[: _LIMITS["taskDescription"]]
        assignee = item.get("assignedAgentId")
        key = _task_key(item.get("key"), keys, len(tasks))
        after, after_task_ids = _task_order(item.get("after"), keys)
        keys.append(key)
        tasks.append(
            {
                "key": key,
                "title": title,
                **({"after": after} if after else {}),
                **({"afterTaskIds": after_task_ids} if after_task_ids else {}),
                **({"description": description} if description else {}),
                **(
                    {"assignedAgentId": assignee.strip()}
                    if isinstance(assignee, str) and assignee.strip()
                    else {}
                ),
            }
        )
        if len(tasks) == SETUP_TASKS_MAX:
            break
    return tasks


def _task_key(raw: Any, taken: list[str], index: int) -> str:
    key = raw.strip().lower() if isinstance(raw, str) else ""
    if _TASK_KEY.match(key) and key not in taken:
        return key
    fallback = f"task-{index + 1}"
    while fallback in taken:
        fallback = f"{fallback}-x"
    return fallback


def _task_order(raw: Any, earlier: list[str]) -> tuple[list[str], list[str]]:
    if not isinstance(raw, list):
        return [], []
    after: list[str] = []
    after_task_ids: list[str] = []
    for ref in raw:
        if not isinstance(ref, str) or not ref.strip():
            continue
        ref = ref.strip().lower()
        if _TASK_ID.match(ref):
            if ref not in after_task_ids:
                after_task_ids.append(ref)
        elif ref in earlier and ref not in after:
            after.append(ref)
        # Any other key names a later or unknown task; dropping it is what
        # keeps the proposal acyclic.
    return after, after_task_ids


def _clip(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit].strip()
