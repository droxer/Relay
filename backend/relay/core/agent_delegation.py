"""The stored, default-deny permission to delegate to other Logical Agents."""

from typing import Any


def delegation_agent_ids(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > 20 or any(
        not isinstance(item, str) or not item.strip() or len(item) > 200 for item in value
    ):
        raise ValueError("delegationAgentIds must contain at most 20 nonempty agent ids.")
    return list(dict.fromkeys(item.strip() for item in value))
