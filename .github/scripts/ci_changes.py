"""Select CI suites from the complete push or pull request diff."""

import json
import os
import subprocess
from pathlib import Path


def changed_paths(event_name: str, event: dict) -> list[str] | None:
    if event_name == "pull_request":
        base = event["pull_request"]["base"]["sha"]
        head = event["pull_request"]["head"]["sha"]
        revision = f"{base}...{head}"
    elif event_name == "push" and event.get("before", "").strip("0"):
        revision = f"{event['before']}..{event['after']}"
    else:
        return None  # Manual runs and new branches exercise everything.
    try:
        result = subprocess.check_output(
            ["git", "diff", "--name-only", "--no-renames", "-z", revision]
        )
    except subprocess.CalledProcessError:
        return None  # A force push may leave the previous commit unavailable.
    return [os.fsdecode(path) for path in result.split(b"\0") if path]


def suites(paths: list[str] | None) -> dict[str, bool]:
    common = paths is None or any(
        path.startswith(".github/")
        or path in {"package.json", "package-lock.json", "Makefile"}
        for path in paths
    )
    paths = paths or []
    return {
        "python": common
        or any(
            path.startswith("backend/")
            or path.endswith(".py")
            or path in {"pyproject.toml", "uv.lock", ".python-version"}
            for path in paths
        ),
        "web": common
        or any(
            path.startswith(("web/", "packages/relay-core/", "tools/vendor/"))
            or path == "packages/tsconfig.json"
            for path in paths
        ),
    }


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    selected = suites(changed_paths(os.environ["GITHUB_EVENT_NAME"], event))
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for name, enabled in selected.items():
            print(f"{name}={str(enabled).lower()}", file=output)
