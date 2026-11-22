"""Wire values for user-confirmed daemon report cleanup."""

import re
from typing import Any

REPORT_CLEANUP = "reports.cleanup"
REPORT_CLEANUP_RESULT = "reports.cleanup-result"
REPORT_CLEANUP_SCOPES = ("all", "quarantined")
REPORT_CLEANUP_TIMEOUT_MS = 30_000
_REVISION = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def report_queue_revision(value: Any) -> str:
    if not isinstance(value, str) or not _REVISION.fullmatch(value):
        raise ValueError("Invalid report queue revision.")
    return value


def report_cleanup_result(body: dict[str, Any]) -> dict[str, Any]:
    outcome = body.get("outcome")
    if outcome not in ("ready", "discarded", "changed", "busy", "expired", "failed"):
        raise ValueError("Invalid report cleanup outcome.")
    result = {"outcome": outcome, "revision": report_queue_revision(body.get("revision"))}
    for key in ("pending", "quarantined", "discarded"):
        count = body.get(key)
        if key == "discarded" and outcome != "discarded":
            continue
        if type(count) is not int or not 0 <= count <= 2**53 - 1:
            raise ValueError(f"Invalid report count {key}.")
        result[key] = count
    if result["quarantined"] > result["pending"]:
        raise ValueError("Quarantined reports exceed the retained count.")
    return result
