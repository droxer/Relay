"""The check definition selected by the owner and its bounded daemon result."""

import re
from typing import Any

CHECK_FIELD = "verificationCheck"
CHECK_REVISION_FIELD = "verificationCheckRevision"
RESULT_FIELD = "verificationResult"
CHECK_STATE_KEY = "_relay_verification_check"
CHECK_OUTPUT_LIMIT = 4096
_COMMIT = re.compile(r"[a-f0-9]{40}|[a-f0-9]{64}")
_PATH_COMPONENT = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*")


def is_git_commit(value: Any) -> bool:
    return isinstance(value, str) and _COMMIT.fullmatch(value) is not None


def check_definition(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict) or set(value) != {"commit", "path"}:
        return None
    commit, path = value["commit"], value["path"]
    if not is_git_commit(commit) or not isinstance(path, str) or len(path) > 240:
        return None
    if not all(_PATH_COMPONENT.fullmatch(part) for part in path.split("/")):
        return None
    return {"commit": commit, "path": path}


def recorded_check_result(value: Any, check: dict[str, str]) -> dict[str, Any]:
    if isinstance(value, dict) and check_definition(value.get("check")) == check:
        status, candidate = value.get("status"), value.get("candidateCommit")
        output = value.get("output")
        if (status in ("passed", "failed", "error") and isinstance(output, str)
                and (is_git_commit(candidate) or status == "error" and candidate is None)):
            return {"check": check, "status": status, "candidateCommit": candidate,
                    "output": output[:CHECK_OUTPUT_LIMIT]}
    return {"check": check, "status": "error", "candidateCommit": None,
            "output": "The Daemon Node did not report a valid verification result."}
