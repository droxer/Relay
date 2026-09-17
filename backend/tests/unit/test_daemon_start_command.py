from __future__ import annotations

import os
import shutil
import subprocess

import pytest
from starlette.requests import Request

from relay.api.helpers import daemon_start_command


def command(*, prompt: bool = True) -> str:
    request = Request({"type": "http", "scheme": "https", "server": ("relay.example", 443), "path": "/", "root_path": "", "headers": []})
    return daemon_start_command(
        request,
        {"id": "node-test", "employeeId": "alice", "workspacePath": "/tmp/alice's project; $(false)"},
        "none",
        prompt_for_token=prompt,
    )


@pytest.mark.parametrize("shell", ["bash", "zsh"])
def test_launch_prompts_in_supported_shells_and_preserves_arguments(tmp_path, shell):
    executable = shutil.which(shell)
    if not executable:
        pytest.skip(f"{shell} is not installed")
    daemon = tmp_path / "relay-daemon"
    daemon.write_text('#!/bin/bash\nprintf "%s\\n" "$RELAY_DAEMON_NODE_TOKEN" "$@"\n')
    daemon.chmod(0o755)
    result = subprocess.run(
        [executable, "-c", command()], input="test-token\n", text=True,
        capture_output=True, env={**os.environ, "PATH": f"{tmp_path}:/usr/bin:/bin"},
    )
    assert result.returncode == 0, result.stderr
    assert "test-token" in result.stdout.splitlines()
    assert "/tmp/alice's project; $(false)" in result.stdout.splitlines()
    assert "test-token" not in command()


def test_missing_daemon_reports_setup_before_reading_token(tmp_path):
    (tmp_path / "bash").symlink_to(shutil.which("bash"))
    result = subprocess.run(
        [shutil.which("bash"), "-c", command()], input="", text=True,
        capture_output=True, env={**os.environ, "PATH": str(tmp_path)},
    )
    assert result.returncode == 127
    assert "setup" in result.stderr.lower()
    assert "Relay node token:" not in result.stderr


def test_reconnect_without_prompt_uses_saved_token(tmp_path):
    daemon = tmp_path / "relay-daemon"
    daemon.write_text('#!/bin/bash\nprintf "started\\n"\n')
    daemon.chmod(0o755)
    result = subprocess.run(
        ["bash", "-c", command(prompt=False)], input="", text=True,
        capture_output=True, env={**os.environ, "PATH": f"{tmp_path}:/usr/bin:/bin"},
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "started\n"
