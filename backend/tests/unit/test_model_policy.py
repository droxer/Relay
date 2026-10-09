from __future__ import annotations

import pytest

from relay.core.model_policy import normalize_model_policy, policy_model


@pytest.mark.parametrize(
    "model",
    [
        "claude-opus-5-5",
        "gpt-5.1-codex",
        "openai/gpt-5",
        "qwen3:32b",
        "claude-sonnet-5-5[1m]",
    ],
)
def test_accepts_runtime_model_ids(model: str) -> None:
    assert normalize_model_policy({"model": f"  {model} "}) == {"model": model}


@pytest.mark.parametrize("value", [{}, {"model": None}, {"model": "   "}])
def test_blank_model_means_runtime_default(value: dict) -> None:
    assert normalize_model_policy(value) == {}


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ({"model": "gpt; rm -rf /"}, "may only contain"),
        ({"model": "-m"}, "may only contain"),
        ({"model": 5}, "must be a string"),
        ({"model": "a" * 129}, "at most 128"),
        ({"model": "gpt-5", "temperature": 0}, "Unsupported modelPolicy"),
    ],
)
def test_rejects_unsafe_or_unknown_policy(value: dict, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        normalize_model_policy(value)


def test_policy_model_reads_pinned_model() -> None:
    assert policy_model({"modelPolicy": {"model": "gpt-5"}}) == "gpt-5"
    assert policy_model({"modelPolicy": {}}) is None
    assert policy_model({}) is None
