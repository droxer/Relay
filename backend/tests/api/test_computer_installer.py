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
    response = client.get("/install.sh")
    assert response.status_code == 200
    assert "text/x-shellscript" in response.headers["content-type"]
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    assert digest in response.text
    assert f"https://api.example.com/computer/daemon-{digest}.tar.gz" in response.text
    assert "@@" not in response.text
    # `| bash` is the published form; `| sh` and older `| sudo bash` copies also work.
    for shell in ("bash", "sh"):
        assert subprocess.run([shell, "-n"], input=response.text, text=True).returncode == 0
    assert client.get("/computer/install.sh").text == response.text
    archive = client.get(f"/computer/daemon-{digest}.tar.gz")
    assert archive.content == bundle.read_bytes()
    assert "immutable" in archive.headers["cache-control"]
    # The edge caches this path, so a miss must never be kept there.
    for missing in (f"/computer/daemon-{'0' * 64}.tar.gz", "/computer/daemon-not-a-digest.tar.gz"):
        response = client.get(missing)
        assert response.status_code == 404
        assert response.headers["cache-control"] == "no-store"


def test_installer_missing_build_fails_explicitly(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_COMPUTER_BUNDLE", str(tmp_path / "missing"))
    client = TestClient(create_app(str(tmp_path / "state")))
    assert client.get("/install.sh").status_code == 503
    assert client.get("/computer/install.sh").status_code == 503


def test_setup_command_is_the_bare_installer_pipeline(monkeypatch):
    from starlette.requests import Request
    from relay.api.computer_installer_routes import computer_setup_command

    monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", "https://eveland.ai")
    monkeypatch.delenv("RELAY_PUBLIC_WEB_URL", raising=False)
    request = Request({"type": "http", "scheme": "http", "server": ("internal", 80), "path": "/", "headers": []})
    assert computer_setup_command(request) == "curl -fsSL https://eveland.ai/install.sh | bash"


def test_setup_command_names_the_web_origin_when_split(monkeypatch):
    from starlette.requests import Request
    from relay.api.computer_installer_routes import computer_setup_command

    # The web host redirects /install.sh to the API, so people see one domain.
    monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", "https://api.get-relay.cc")
    monkeypatch.setenv("RELAY_PUBLIC_WEB_URL", "https://get-relay.cc")
    request = Request({"type": "http", "scheme": "http", "server": ("internal", 80), "path": "/", "headers": []})
    assert computer_setup_command(request) == "curl -fsSL https://get-relay.cc/install.sh | bash"


def test_install_command_quotes_user_paths_and_uses_public_origin(monkeypatch):
    from starlette.requests import Request
    from relay.api.computer_installer_routes import computer_install_command

    monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", "https://api.example.com")
    monkeypatch.delenv("RELAY_PUBLIC_WEB_URL", raising=False)
    request = Request({"type": "http", "scheme": "http", "server": ("internal", 80), "path": "/", "headers": []})
    workspace = "/Users/alice/a project/$(touch pwned)'"
    command = computer_install_command(request, {"id": "node-1", "userId": "alice", "workspacePath": workspace})
    assert command.startswith("curl -fsSL https://api.example.com/install.sh | bash -s -- ")
    args = shlex.split(command.split(" | bash -s -- ")[1])
    assert args == ["--sandbox-id", "node-1", "--user-id", "alice", "--workspace", workspace]


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
        # `id -u` reports root only while FAKE_ROOT is set; `id -u <name>` never does.
        "id": '#!/bin/sh\n[ "${FAKE_ROOT:-}" = 1 ] && [ "$#" = 1 ] && { printf "0\\n"; exit; }\nprintf "501\\n"\n',
        # Records the hand-off, then runs it as the (already unprivileged) test user.
        "su": '#!/bin/sh\nprintf "%s\\n" "$@" > "$FIXTURE_SU"\nunset FAKE_ROOT\nexec sh -c "$4"\n',
    }
    for name, contents in scripts.items():
        path = bin_dir / name
        path.write_text(contents)
        path.chmod(0o755)
    home = tmp_path / "a home with spaces"
    home.mkdir()
    env = {**os.environ, "HOME": str(home), "PATH": f"{bin_dir}:{os.environ['PATH']}",
           "RELAY_DAEMON_NODE_TOKEN": "test-token", "FIXTURE_ARCHIVE": str(archive),
           "FIXTURE_ARGS": str(tmp_path / "args"), "FIXTURE_SU": str(tmp_path / "su")}
    env.pop("SUDO_USER", None)
    source = (Path(__file__).parents[2] / "relay/computer/install.sh").read_text()
    source = source.replace("@@BUNDLE_URL@@", "https://relay.example.com/client.tar.gz")
    source = source.replace("@@BACKEND_URL@@", "https://relay.example.com")
    source = source.replace("@@BUNDLE_SHA256@@", hashlib.sha256(archive.read_bytes()).hexdigest())
    return source, env


def test_piped_installer_preserves_paths_and_does_not_print_token(tmp_path):
    source, env = _shell_fixture(tmp_path)
    args = ["--backend-url", "https://relay.example.com", "--sandbox-id", "node-1", "--user-id", "alice", "--workspace", "/a path/$(not-executed)"]
    for _ in range(2):  # reinstall reuses the verified release
        result = subprocess.run(["sh", "-s", "--", *args], input=source, env=env, text=True, capture_output=True)
        assert result.returncode == 0, result.stderr
        assert "INSTALL_STARTED" in result.stdout
        assert "test-token" not in result.stdout + result.stderr
        assert (tmp_path / "args").read_text().splitlines()[1:] == args


def test_bare_installer_supplies_the_backend_it_was_served_from(tmp_path):
    source, env = _shell_fixture(tmp_path)
    # No controlling terminal: the workspace prompt is skipped, not left blocking.
    result = subprocess.run(["bash"], input=source, env=env, text=True, capture_output=True, start_new_session=True)
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "args").read_text().splitlines()[1:] == ["--backend-url", "https://relay.example.com"]


def test_sudo_installs_for_the_invoking_user_not_root(tmp_path):
    source, env = _shell_fixture(tmp_path)
    env.update(FAKE_ROOT="1", SUDO_USER="alice")
    args = ["--sandbox-id", "node-1", "--user-id", "alice", "--workspace", "/a path/$HOME $(not-executed)'"]
    result = subprocess.run(["bash", "-s", "--", *args], input=source, env=env, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert "INSTALL_STARTED" in result.stdout
    # Root never runs the client: it hands the install to alice's login shell.
    assert (tmp_path / "su").read_text().splitlines() == ["-l", "alice", "-c", "exec bash -s"]
    assert (tmp_path / "args").read_text().splitlines()[1:] == ["--backend-url", "https://relay.example.com", *args]
    assert "test-token" not in result.stdout + result.stderr


def test_sudo_hand_off_failure_fails_the_installer(tmp_path):
    source, env = _shell_fixture(tmp_path)
    env.update(FAKE_ROOT="1", SUDO_USER="alice", FAIL_DOWNLOAD="1")
    result = subprocess.run(["bash"], input=source, env=env, text=True, capture_output=True)
    assert result.returncode != 0
    assert not (tmp_path / "args").exists()


def test_root_without_an_invoking_user_is_refused(tmp_path):
    source, env = _shell_fixture(tmp_path)
    for sudo_user in (None, "root"):
        env.update(FAKE_ROOT="1")
        env.pop("SUDO_USER", None)
        if sudo_user:
            env["SUDO_USER"] = sudo_user
        # A root shell's own account is uid 0 whichever way it is looked up.
        (tmp_path / "bin/id").write_text('#!/bin/sh\nprintf "0\\n"\n')
        result = subprocess.run(["bash"], input=source, env=env, text=True, capture_output=True)
        assert result.returncode != 0
        assert "normal user" in result.stderr
        assert not (tmp_path / "su").exists()
        assert not (tmp_path / "args").exists()


def test_sudo_hand_off_requires_bash(tmp_path):
    source, env = _shell_fixture(tmp_path)
    env.update(FAKE_ROOT="1", SUDO_USER="alice", BASH_VERSION="")
    result = subprocess.run(["sh"], input=source, env=env, text=True, capture_output=True)
    if result.returncode == 0:  # /bin/sh is bash on this host; nothing to refuse
        return
    assert "sudo bash" in result.stderr
    assert not (tmp_path / "args").exists()


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


def test_workspace_prompt_uses_controlling_tty_with_piped_stdin(tmp_path):
    # Node's fs read of /dev/tty dies with EINTR under sudo's terminal relay, so
    # the shell asks and hands the client --workspace.
    import os
    import select
    import sys
    import time

    source, env = _shell_fixture(tmp_path)
    script = tmp_path / "installer.sh"
    script.write_text(source)
    command = f"cat {shlex.quote(str(script))} | sh -s -- --foreground"
    argv = (["script", "-q", "/dev/null", "sh", "-c", command] if sys.platform == "darwin"
            else ["script", "-q", "-c", command, "/dev/null"])
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, env=env)

    def read_until(marker: bytes, output: bytes) -> bytes:
        deadline = time.monotonic() + 10
        while marker not in output and time.monotonic() < deadline:
            if select.select([process.stdout], [], [], 0.2)[0]:
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                output += chunk
        return output

    try:
        assert process.stdout is not None and process.stdin is not None
        output = read_until(b"Local workspace directory", b"")
        assert b"Local workspace directory" in output, output
        process.stdin.write(b"~/my work\n")
        process.stdin.flush()
        output = read_until(b"INSTALL_STARTED", output)
        assert b"INSTALL_STARTED" in output, output
        tail, _ = process.communicate(timeout=10)
        assert process.returncode == 0, output + tail
        assert (tmp_path / "args").read_text().splitlines()[1:] == [
            "--backend-url", "https://relay.example.com", "--foreground",
            "--workspace", f"{env['HOME']}/my work"]
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
    node = {"id": "node-1", "userId": "alice", "workspacePath": "/home/alice/project",
            "nodeLocation": "user-device", "sandboxMode": "none"}
    response = _token_response(request, node, "fixture-token")
    assert "curl -fsSL" in response["installCommand"]
    assert "fixture-token" not in response["installCommand"]
    for overrides in [
        {"sandboxMode": "boxlite"}, {"nodeLocation": "cloud"},
        {"workspacePath": None}, {"userId": None},
    ]:
        response = _token_response(request, {**node, **overrides}, "fixture-token")
        assert "installCommand" not in response
        assert "daemonCommand" in response


def test_windows_installer_is_public_pinned_and_ascii(monkeypatch, tmp_path):
    bundle = tmp_path / "daemon.tar.gz"
    bundle.write_bytes(b"release fixture")
    monkeypatch.setenv("RELAY_COMPUTER_BUNDLE", str(bundle))
    monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", "https://api.example.com")
    client = TestClient(create_app(str(tmp_path / "state")))
    response = client.get("/install.ps1")
    assert response.status_code == 200
    # `irm` returns a string only for a textual content type.
    assert response.headers["content-type"] == "text/plain; charset=utf-8"
    assert response.headers["cache-control"] == "no-store"
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    assert f"Get-RelayFile 'https://api.example.com/computer/daemon-{digest}.tar.gz' $bundle" in response.text
    assert "@('--backend-url', 'https://api.example.com')" in response.text
    assert f"Test-RelaySha256 $bundle '{digest}'" in response.text
    assert "@@" not in response.text
    # Windows PowerShell may decode the download as Latin-1.
    assert response.text.isascii()
    # It runs inside the user's own session: `exit` would close their window.
    assert not any(line.strip().startswith("exit") for line in response.text.splitlines())
    assert client.get("/computer/install.ps1").text == response.text


def test_windows_installer_missing_build_fails_explicitly(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_COMPUTER_BUNDLE", str(tmp_path / "missing"))
    client = TestClient(create_app(str(tmp_path / "state")))
    assert client.get("/install.ps1").status_code == 503


def test_windows_commands_quote_every_argument_for_powershell(monkeypatch):
    from starlette.requests import Request
    from relay.api.computer_installer_routes import computer_windows_install_command, computer_windows_setup_command

    monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", "https://api.example.com")
    request = Request({"type": "http", "scheme": "http", "server": ("internal", 80), "path": "/", "headers": []})
    assert computer_windows_setup_command(request) == "irm 'https://api.example.com/install.ps1' | iex"
    workspace = "C:\\Users\\o'brien\\My Work $(evil)"
    command = computer_windows_install_command(request, {"id": "node-1", "userId": "alice", "workspacePath": workspace})
    assert command == (
        "& ([scriptblock]::Create((irm 'https://api.example.com/install.ps1'))) "
        "'--sandbox-id' 'node-1' '--user-id' 'alice' '--workspace' 'C:\\Users\\o''brien\\My Work $(evil)'"
    )


def _bundle_with(tmp_path, manifest):
    import io
    import json
    import tarfile

    path = tmp_path / "daemon.tar.gz"
    with tarfile.open(path, "w:gz") as archive:
        if manifest is not None:
            data = json.dumps(manifest).encode()
            info = tarfile.TarInfo("node_modules/relay-daemon/capabilities.json")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return path


def test_a_bundle_lacking_a_required_capability_is_named(tmp_path):
    from relay.api.computer_installer_routes import bundle_missing_capabilities
    from relay.core.daemon_capabilities import DAEMON_NODE_CAPABILITIES

    current = _bundle_with(tmp_path, {"capabilities": sorted(DAEMON_NODE_CAPABILITIES)})
    assert bundle_missing_capabilities(current) == []
    stale = _bundle_with(tmp_path, {"capabilities": sorted(DAEMON_NODE_CAPABILITIES - {"project-links"})})
    assert bundle_missing_capabilities(stale) == ["project-links"]
    # Built before the manifest existed: nothing to compare, which is itself stale.
    assert bundle_missing_capabilities(_bundle_with(tmp_path, None)) is None


def test_startup_warns_about_a_stale_bundle(monkeypatch, tmp_path):
    from loguru import logger
    from relay.api.computer_installer_routes import warn_if_bundle_stale

    messages: list[str] = []
    sink = logger.add(lambda message: messages.append(message.record["message"]), level="WARNING")
    try:
        warn_if_bundle_stale(_bundle_with(tmp_path, {"capabilities": []}))
        warn_if_bundle_stale(tmp_path / "missing")
        not_a_tar = tmp_path / "broken.tar.gz"
        not_a_tar.write_bytes(b"not a tarball")
        warn_if_bundle_stale(not_a_tar)
    finally:
        logger.remove(sink)
    assert len(messages) == 2
    assert "will read as outdated" in messages[0]
    assert "unreadable" in messages[1]
