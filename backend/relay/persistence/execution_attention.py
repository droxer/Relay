"""Deterministic explanations derived solely from the blocked event."""

from typing import Any

UNKNOWN_REASON = "Execution needs attention."


def blocked_attention(event: dict[str, Any]) -> dict[str, Any]:
    metadata = event.get("attention")
    metadata = metadata if isinstance(metadata, dict) else {}
    reason = event.get("reason")
    reason = reason.strip()[:2000] if isinstance(reason, str) else ""
    known_reason = bool(reason and reason != UNKNOWN_REASON)
    code = metadata.get("code")
    code = code if isinstance(code, str) and code and len(code) <= 100 else "unknown"
    source = metadata.get("source")
    if source not in ("dispatch", "execution", "operator", "legacy"):
        source = "legacy"
    result = {
        "schemaVersion": 1,
        "code": code,
        "source": source,
        "summary": reason if known_reason else "The blocking event did not record a cause.",
        "evidence": "recorded" if known_reason else "unknown",
        "observedAt": event["timestamp"],
    }
    for key in ("sessionId", "runRequestId", "runId"):
        value = metadata.get(key)
        if isinstance(value, str) and value and len(value) <= 200:
            result[key] = value
    return result
