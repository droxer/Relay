"""Bounded, permission-neutral collaboration inputs shared by API and runtime."""

from __future__ import annotations

from typing import Any

ROLES = frozenset({"planner", "implementer", "tester", "reviewer", "fixer"})


def text_list(value: Any, name: str, *, limit: int = 20) -> list[str]:
    if (
        not isinstance(value, list)
        or len(value) > limit
        or any(
            not isinstance(item, str) or not item.strip() or len(item) > 2000
            for item in value
        )
    ):
        raise ValueError(
            f"{name} must contain at most {limit} nonempty strings (2000 characters each)."
        )
    return list(dict.fromkeys(item.strip() for item in value))


def member_configs(value: Any, members: list[str]) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or set(value) - set(members):
        raise ValueError("memberConfigs must name only current team members.")
    result = {}
    for agent_id, config in value.items():
        if not isinstance(config, dict) or set(config) - {
            "role",
            "responsibility",
            "required",
            "participation",
            "expectedOutputs",
        }:
            raise ValueError("Unsupported membership configuration.")
        if "role" in config and (
            not isinstance(config["role"], str) or config["role"] not in ROLES
        ):
            raise ValueError("Invalid team role.")
        if "required" in config and not isinstance(config["required"], bool):
            raise ValueError("required must be a boolean.")
        if config.get("participation", "always") not in ("always", "on_request"):
            raise ValueError("participation must be always or on_request.")
        if config.get("participation") == "on_request" and config.get(
            "required", False
        ):
            raise ValueError("An on-request member cannot be a required participant.")
        responsibility = config.get("responsibility", "")
        if not isinstance(responsibility, str) or len(responsibility) > 4000:
            raise ValueError("responsibility must be at most 4000 characters.")
        result[agent_id] = {
            **config,
            **(
                {"responsibility": responsibility.strip()}
                if "responsibility" in config
                else {}
            ),
            **(
                {
                    "expectedOutputs": text_list(
                        config["expectedOutputs"], "expectedOutputs"
                    )
                }
                if "expectedOutputs" in config
                else {}
            ),
        }
    return result
