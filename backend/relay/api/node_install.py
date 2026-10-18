"""Commands and environment for installing a daemon on a user's computer.
"""

from __future__ import annotations

import shlex
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any
from fastapi import HTTPException, Request
from ..core.deploy_config import public_backend_url


def backend_base_url(request: Request) -> str:
    return public_backend_url() or str(request.base_url).rstrip("/")


def valid_user_workspace_path(value: str | None) -> bool:
    if not value:
        return False
    return PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute()


# A user device runs its agents as host processes against the installs
# already on it. BoxLite isolation belongs to hardware an admin provisions, so
# `nodeLocation` and `sandboxMode` are not independent settings.
USER_DEVICE_SANDBOX_MODE = "none"


def assert_user_device_runtime(
    node_location: str | None, sandbox_mode: str | None
) -> None:
    """Reject a user-device node asking for the isolated runtime.

    Both the self-service enrollment route and the admin create route land on
    the same `provision_daemon_node`, which stores `sandboxMode` verbatim — so
    the pair has to be checked before it becomes a start command. Enforced here
    rather than per-route: a caller that slips through gets `--sandbox boxlite`
    with no `--use-local-agent-home`, and the daemon tries to boot a VM on a
    laptop that was never set up for one.
    """
    if node_location != "user-device":
        return
    if sandbox_mode != USER_DEVICE_SANDBOX_MODE:
        raise HTTPException(
            400,
            'sandboxMode must be "none" for a user-device computer: '
            "a personal computer runs agents directly.",
        )


def daemon_start_env(
    request: Request, node: dict[str, Any], sandbox_mode: str = "boxlite"
) -> dict[str, str]:
    env = {
        "RELAY_BACKEND_URL": backend_base_url(request),
        "RELAY_SANDBOX_ID": node["id"],
        "RELAY_SANDBOX_MODE": sandbox_mode,
    }
    # Reusing the host user's agent auth only makes sense when agents run as
    # direct execution; in boxlite mode guest provisioning handles agent auth.
    if sandbox_mode == "none":
        env["RELAY_ALLOW_HOST_AGENT_EXECUTION"] = "1"
        env["RELAY_USE_LOCAL_AGENT_HOME"] = "1"
    if node.get("userId"):
        env["RELAY_USER_ID"] = node["userId"]
    if node.get("nodeToken"):
        env["RELAY_DAEMON_NODE_TOKEN"] = node["nodeToken"]
    if node.get("workspacePath"):
        env["RELAY_WORKSPACE"] = node["workspacePath"]
    return env


def daemon_start_command(
    request: Request,
    node: dict[str, Any],
    sandbox_mode: str = "boxlite",
    *,
    prompt_for_token: bool = True,
) -> str:
    """The shell line that starts this node's daemon. Never carries the token.

    `prompt_for_token=False` is for a node that already enrolled: its machine
    holds the token on disk (`ensureDaemonNodeToken`), so prompting for a
    secret the reader was shown once and no longer has would strand them.
    """
    parts = [
        "--backend-url",
        backend_base_url(request),
        "--sandbox-id",
        node["id"],
        "--sandbox",
        sandbox_mode,
    ]
    if sandbox_mode == "none":
        parts.extend(["--allow-host-agent-execution", "--use-local-agent-home"])
    if node.get("userId"):
        parts.extend(["--user-id", node["userId"]])
    if node.get("workspacePath"):
        parts.extend(["--workspace", node["workspacePath"]])
    command = " ".join(shlex.quote(part) for part in parts)
    # The copied line is commonly pasted into zsh. Keep Bash's silent read
    # inside an explicit child shell, and keep the token out of the parent
    # shell's environment after the daemon exits.
    script = (
        "relay_daemon=$(command -v relay-daemon) || "
        "relay_daemon=\"$HOME/.local/bin/relay-daemon\"; "
        "test -x \"$relay_daemon\" || { "
        "printf '%s\\n' 'relay-daemon is missing. Complete the first-time setup "
        "in Connect this computer, then run this command again.' >&2; "
        "exit 127; }; "
    )
    if prompt_for_token:
        script += (
            "read -rsp 'Relay node token: ' RELAY_DAEMON_NODE_TOKEN && echo && "
            "test -n \"$RELAY_DAEMON_NODE_TOKEN\" && "
            "export RELAY_DAEMON_NODE_TOKEN && "
        )
    return "bash -c " + shlex.quote(script + 'exec "$relay_daemon" ' + command)
