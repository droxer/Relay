"""An agent's model choice: which LLM its runtime CLI should run.

``modelPolicy`` is ``{}`` (the runtime's own default) or ``{"model": "<id>"}``.
The id is passed verbatim to the runtime's model flag, so it is validated here
rather than trusted: catalogs differ per runtime and per provider, so the shape
is checked, not membership in a list.
"""

from __future__ import annotations

import re
from typing import Any

MODEL_ID_MAX_LENGTH = 128
# Covers bare ids (claude-opus-5-5, gpt-5.1-codex), provider-qualified ids
# (openai/gpt-5), tagged ids (qwen3:32b), and context suffixes ([1m]).
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@\[\]+-]*$")


def normalize_model_policy(value: dict[str, Any]) -> dict[str, Any]:
    unknown = set(value) - {"model"}
    if unknown:
        raise ValueError(
            f"Unsupported modelPolicy field(s): {', '.join(sorted(unknown))}."
        )
    model = value.get("model")
    if model is None:
        return {}
    if not isinstance(model, str):
        raise ValueError("modelPolicy.model must be a string.")
    model = model.strip()
    if not model:
        return {}
    if len(model) > MODEL_ID_MAX_LENGTH:
        raise ValueError(
            f"modelPolicy.model must be at most {MODEL_ID_MAX_LENGTH} characters."
        )
    if not _MODEL_ID.match(model):
        raise ValueError(
            "modelPolicy.model may only contain letters, digits, and . _ : / @ [ ] + -"
        )
    return {"model": model}


def is_model_id(value: Any) -> bool:
    """Whether ``value`` is a model id the policy would accept as given."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= MODEL_ID_MAX_LENGTH
        and _MODEL_ID.match(value) is not None
    )


def policy_model(agent: dict[str, Any]) -> str | None:
    """The model an agent pins, or None to use the runtime's default."""
    policy = agent.get("modelPolicy")
    model = policy.get("model") if isinstance(policy, dict) else None
    return model if isinstance(model, str) and model else None
