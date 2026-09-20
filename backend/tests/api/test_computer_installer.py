from __future__ import annotations

import hashlib
import shlex
import subprocess

from fastapi.testclient import TestClient
from relay.app import create_app


def test_installer_is_public_and_pins_the_archive(monkeypatch, tmp_path):
    bundle = tmp_path / "daemon.tar.gz"
    bundle.write_bytes(b"release fixture")
    monkeypatch.setenv("RELAY_COMPUTER_BUNDLE", str(bundle))
    monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", "https://api.example.com")
    client = TestClient(create_app(str(tmp_path / "state")))
    response = client.get("/computer/install.sh")
    assert response.status_code == 200
    assert "text/x-shellscript" in response.headers["content-type"]
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    assert digest in response.text
    assert f"https://api.example.com/computer/daemon-{digest}.tar.gz" in response.text
    assert subprocess.run(["sh", "-n"], input=response.text, text=True).returncode == 0
    archive = client.get(f"/computer/daemon-{digest}.tar.gz")
    assert archive.content == bundle.read_bytes()
    assert client.get(f"/computer/daemon-{'0' * 64}.tar.gz").status_code == 404


def test_installer_missing_build_fails_explicitly(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_COMPUTER_BUNDLE", str(tmp_path / "missing"))
    client = TestClient(create_app(str(tmp_path / "state")))
    assert client.get("/computer/install.sh").status_code == 503


def test_install_command_quotes_user_paths_and_uses_public_origin(monkeypatch):
    from starlette.requests import Request
    from relay.api.computer_installer_routes import computer_install_command

    monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", "https://api.example.com")
    request = Request({"type": "http", "scheme": "http", "server": ("internal", 80), "path": "/", "headers": []})
    workspace = "/Users/alice/a project/$(touch pwned)'"
    command = computer_install_command(request, {"id": "node-1", "employeeId": "alice", "workspacePath": workspace})
    assert command.startswith("curl -fsSL https://api.example.com/computer/install.sh | sh -s -- ")
    args = shlex.split(command.split(" | sh -s -- ")[1])
    assert args == ["--backend-url", "https://api.example.com", "--sandbox-id", "node-1", "--employee-id", "alice", "--workspace", workspace]


def _shell_fixture(tmp_path):
    import io
    import os
    import tarfile
    from pathlib import Path

    archive = tmp_path / "client.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        info = tarfile.TarInfo("node_modules/relay-daemon/dist/install.js")
        payload = b"// fixture entrypoint"
        info.size = len(payload)
        tar.addfile(info, io.BytesIO(payload))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    # Fake external tools; exercise the real shell installer without networking
    # or touching the operator's home directory or service manager.
    scripts = {
        "curl": '#!/bin/sh\n[ "${FAIL_DOWNLOAD:-}" != 1 ] || exit 22\nwhile [ "$1" != -o ]; do shift; done\ncp "$FIXTURE_ARCHIVE" "$2"\n',
        "node": '#!/bin/sh\n[ "$1" != -e ] || exit 0\n[ -f "$1" ] || exit 9\n[ "$RELAY_DAEMON_NODE_TOKEN" = test-token ] || exit 10\nprintf "INSTALL_STARTED\\n"\nprintf "%s\\n" "$@" > "$FIXTURE_ARGS"\n',
        "id": '#!/bin/sh\nprintf "501\\n"\n',
    }
    for name, contents in scripts.items():
        path = bin_dir / name
        path.write_text(contents)
        path.chmod(0o755)
    home = tmp_path / "a home with spaces"
    home.mkdir()
    env = {**os.environ, "HOME": str(home), "PATH": f"{bin_dir}:{os.environ['PATH']}",
           "RELAY_DAEMON_NODE_TOKEN": "test-token", "FIXTURE_ARCHIVE": str(archive),
           "FIXTURE_ARGS": str(tmp_path / "args")}
    source = (Path(__file__).parents[2] / "relay/computer/install.sh").read_text()
    source = source.replace("@@BUNDLE_URL@@", "https://relay.example.com/client.tar.gz")
    source = source.replace("@@BUNDLE_SHA256@@", hashlib.sha256(archive.read_bytes()).hexdigest())
    return source, env


def test_piped_installer_preserves_paths_and_does_not_print_token(tmp_path):
    source, env = _shell_fixture(tmp_path)
    args = ["--backend-url", "https://relay.example.com", "--sandbox-id", "node-1", "--employee-id", "alice", "--workspace", "/a path/$(not-executed)"]
    for _ in range(2):  # reinstall reuses the verified release
        result = subprocess.run(["sh", "-s", "--", *args], input=source, env=env, text=True, capture_output=True)
        assert result.returncode == 0, result.stderr
        assert "INSTALL_STARTED" in result.stdout
        assert "test-token" not in result.stdout + result.stderr
        assert (tmp_path / "args").read_text().splitlines()[1:] == args


def test_download_failure_does_not_execute_or_replace_client(tmp_path):
    source, env = _shell_fixture(tmp_path)
    env["FAIL_DOWNLOAD"] = "1"
    result = subprocess.run(["sh", "-s", "--", "--foreground"], input=source, env=env, text=True, capture_output=True)
    assert result.returncode != 0
    assert not (tmp_path / "args").exists()
    assert not list((tmp_path / "a home with spaces/.local/share/relay").glob(".install.*"))


def test_corrupt_download_is_never_executed(tmp_path):
    source, env = _shell_fixture(tmp_path)
    from pathlib import Path
    Path(env["FIXTURE_ARCHIVE"]).write_bytes(b"corrupt")
    result = subprocess.run(["sh", "-s", "--", "--foreground"], input=source, env=env, text=True, capture_output=True)
    assert result.returncode != 0
    assert "checksum mismatch" in result.stderr
    assert not (tmp_path / "args").exists()


def test_token_prompt_uses_controlling_tty_with_piped_stdin(tmp_path):
    import os
    import select
    import sys
    import time

    source, env = _shell_fixture(tmp_path)
    env.pop("RELAY_DAEMON_NODE_TOKEN")
    script = tmp_path / "installer.sh"
    script.write_text(source)
    command = f"cat {shlex.quote(str(script))} | sh -s -- --foreground --sandbox-id sbx_test"
    # script(1) supplies a controlling terminal while the installer itself gets
    # a pipe, exactly as curl | sh does. No preexec_fn in the threaded API suite.
    argv = (["script", "-q", "/dev/null", "sh", "-c", command] if sys.platform == "darwin"
            else ["script", "-q", "-c", command, "/dev/null"])
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, env=env)
    output = b""
    try:
        assert process.stdout is not None and process.stdin is not None
        deadline = time.monotonic() + 10
        while b"Relay node token:" not in output and time.monotonic() < deadline:
            if select.select([process.stdout], [], [], 0.2)[0]:
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                output += chunk
        assert b"Relay node token:" in output, output
        time.sleep(0.1)  # allow stty after the prompt to disable echo
        process.stdin.write(b"test-token\n")
        process.stdin.flush()
        # communicate() closes stdin. Keep script(1)'s input open until the
        # installer has consumed the token; otherwise macOS can deliver EOF to
        # the controlling terminal before the queued line reaches read(1).
        deadline = time.monotonic() + 10
        while b"INSTALL_STARTED" not in output and time.monotonic() < deadline:
            if select.select([process.stdout], [], [], 0.2)[0]:
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                output += chunk
        assert b"INSTALL_STARTED" in output, output
        tail, _ = process.communicate(timeout=10)
        output += tail
        assert process.returncode == 0, output
        assert b"INSTALL_STARTED" in output
        assert b"test-token" not in output
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def test_installer_downloads_and_verifies_private_node_when_system_node_is_old(tmp_path):
    import hashlib
    import io
    import tarfile
    from pathlib import Path

    source, env = _shell_fixture(tmp_path)
    bin_dir = tmp_path / "bin"
    client_node = (bin_dir / "node").read_text()
    (bin_dir / "node").write_text(client_node.replace('|| exit 0', '|| exit 1'))
    (bin_dir / "uname").write_text('#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n')
    (bin_dir / "uname").chmod(0o755)
    runtime = tmp_path / "node.tar.gz"
    with tarfile.open(runtime, "w:gz") as tar:
        info = tarfile.TarInfo("node-v24.1.0-darwin-arm64/bin/node")
        payload = client_node.encode()
        info.size = len(payload)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(payload))
    sums = tmp_path / "SHASUMS256.txt"
    sums.write_text(f"{hashlib.sha256(runtime.read_bytes()).hexdigest()}  node-v24.1.0-darwin-arm64.tar.gz\n")
    env.update(FIXTURE_RUNTIME=str(runtime), FIXTURE_SUMS=str(sums))
    (bin_dir / "curl").write_text('''#!/bin/sh
for arg do
    case "$arg" in
      */SHASUMS256.txt) fixture="$FIXTURE_SUMS";;
      */node-v24.*) fixture="$FIXTURE_RUNTIME";;
      */client.tar.gz) fixture="$FIXTURE_ARCHIVE";;
    esac
done
while [ "$1" != -o ]; do shift; done
cp "$fixture" "$2"
''')
    result = subprocess.run(["sh", "-s", "--", "--foreground"], input=source, env=env, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert "Installing a private Node.js" in result.stdout
    assert "INSTALL_STARTED" in result.stdout
    assert (Path(env["HOME"]) / ".local/share/relay/runtimes/node-v24.1.0-darwin-arm64/bin/node").is_file()


def test_token_response_only_offers_installer_for_complete_personal_computers(monkeypatch):
    from starlette.requests import Request
    from relay.api.daemon_node_routes import _token_response

    monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", "https://api.example.com")
    request = Request({"type": "http", "scheme": "http", "server": ("internal", 80), "path": "/", "headers": []})
    node = {"id": "node-1", "employeeId": "alice", "workspacePath": "/home/alice/project",
            "nodeLocation": "employee-device", "sandboxMode": "none"}
    response = _token_response(request, node, "fixture-token")
    assert "curl -fsSL" in response["installCommand"]
    assert "fixture-token" not in response["installCommand"]
    for overrides in [
        {"sandboxMode": "boxlite"}, {"nodeLocation": "cloud"},
        {"workspacePath": None}, {"employeeId": None},
    ]:
        response = _token_response(request, {**node, **overrides}, "fixture-token")
        assert "installCommand" not in response
        assert "daemonCommand" in response
