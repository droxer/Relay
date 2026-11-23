"""Exercise Relay's real HTTP-to-process path with a fixture or an installed agy."""

import base64
import json
import os
import shlex
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest

from daemon_e2e import ROOT, DaemonE2E, eventually


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+sGB0AAAAASUVORK5CYII=")


def _turn(harness, thread_id, text, turn, status="completed", attachments=()):
    _send(harness, thread_id, text, attachments)
    return _settled(harness, thread_id, turn, status)


def _send(harness, thread_id, text, attachments=()):
    harness.post(f"/threads/{thread_id}/messages", {
        "text": text, "addressAgentId": harness.agent["id"], "intent": "discuss",
        **({"attachmentIds": attachments} if attachments else {}),
    }, 202)


def _settled(harness, thread_id, turn, status="completed"):
    def settled():
        if harness.process.poll() is not None:
            pytest.fail((harness.root / "daemon.log").read_text())
        thread = harness.session(thread_id)
        runs = thread["agentRuns"]
        if len(runs) < turn or runs[-1]["status"] not in {"completed", "failed", "cancelled"}:
            return None
        assert runs[-1]["status"] == status, runs[-1]
        return thread, runs[-1]

    return eventually(settled, timeout=90)


def _reply(run):
    events = (json.loads(line) for line in run["agentLog"].splitlines() if line.startswith('{"type":'))
    return "".join(event["part"]["text"] for event in events if event["type"] == "text")


@pytest.mark.integration
@pytest.mark.parametrize("live", [False, True], ids=["fixture", "live"])
def test_antigravity_thread(tmp_path, monkeypatch, live):
    if live and os.environ.get("RELAY_LIVE_ANTIGRAVITY") != "1":
        pytest.skip("Set RELAY_LIVE_ANTIGRAVITY=1 to exercise the installed, signed-in agy.")
    if not (ROOT / "packages/relay-daemon/dist/index.js").exists():
        pytest.skip("Build the Relay daemon before running this integration test.")

    options = {}
    browser = os.environ.get("RELAY_ANTIGRAVITY_BROWSER") == "1"
    if browser:
        web = Path(os.environ.get("RELAY_ANTIGRAVITY_WEB_DIST", ROOT / "web/out")).resolve()
        assert (web / "index.html").exists(), "Build the web export before running the browser check."
        monkeypatch.setenv("RELAY_WEB_UI_DIST_DIR", str(web))
    if not live:
        home = tmp_path / "home"
        bin_dir = home / "bin"
        bin_dir.mkdir(parents=True)
        settings = home / ".gemini" / "antigravity-cli" / "settings.json"
        settings.parent.mkdir(parents=True)
        settings.write_text(json.dumps({"model": "Gemini test"}))
        cli = ROOT / "packages/relay-daemon/tests/fixtures/agy-e2e.mjs"
        shim = bin_dir / "agy"
        shim.write_text(f'#!/bin/sh\nexec node {shlex.quote(str(cli))} "$@"\n')
        shim.chmod(0o755)
        monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
        options["agentHome"] = str(home)

    harness = DaemonE2E(tmp_path, monkeypatch, executor_kind="antigravity",
                        daemon_fixture="antigravity-e2e.mjs", daemon_options=options)
    try:
        harness.setup(create_project=False)

        def ready_node():
            nodes = harness.client.get("/api/v1/daemon-nodes").json()["nodes"]
            node = next((node for node in nodes if node["id"] == harness.node_id), {})
            if node.get("agents", {}).get("antigravity") == "ready" and node.get("agentModels", {}).get("antigravity"):
                return node
            return None

        node = eventually(ready_node)
        model = node["agentModels"]["antigravity"][0]
        if not live:
            assert node["agentDefaultModels"]["antigravity"] == model == "gemini-test"
        pin = harness.client.patch(f"/api/v1/agents/{harness.agent['id']}", json={"modelPolicy": {"model": model}})
        assert pin.status_code == 200, pin.text
        thread = harness.post("/threads", {
            "taskGoal": "Verify Google Antigravity",
            "daemonNodeId": harness.node_id,
            "assignments": [{"agent": "antigravity", "agentId": harness.agent["id"]}],
        }, 201)["id"]

        marker = "relay-agy-" + uuid4().hex[:12] if live else "RELAY_AGY_FIRST"
        image = harness.client.post("/api/v1/thread-attachments", content=PNG, headers={"Content-Type": "image/png"})
        assert image.status_code == 201, image.text
        first_thread, first = _turn(
            harness, thread, f"Remember this marker and reply with exactly {marker}. Do not invoke any tools.", 1,
            attachments=[image.json()["id"]],
        )
        assert marker in _reply(first)
        assert first["agent"] == "antigravity"
        assert first["tokenUsage"]["total"] > 0
        assert any(event["type"].startswith("agent.output") for event in first_thread["events"])
        conversation = first["runtimeSessionId"]

        follow_up = "Reply with the exact marker from my previous message. Do not invoke any tools." if live else "RELAY_AGY_FOLLOW_UP"
        _, second = _turn(harness, thread, follow_up, 2)
        assert (marker if live else "RELAY_AGY_RESUMED") in _reply(second)
        assert second["runtimeSessionId"] == conversation
        dispatches = [event for event in harness.traces() if event["kind"] == "dispatch"]
        assert dispatches[:2] == [
            {"kind": "dispatch", "model": model},
            {"kind": "dispatch", "model": model, "resume": conversation},
        ]
        approval = "Run exactly the shell command `printf RELAY_AGY_APPROVAL` once. If permission is denied, stop."
        _send(harness, thread, approval)
        requests = eventually(lambda: harness.session(thread).get("permissionRequests"), timeout=90)
        [request] = requests
        assert request["toolName"] == "run_command"
        assert "printf RELAY_AGY_APPROVAL" in request["input"]
        if browser:
            subprocess.run([
                "node", str(ROOT / "web/e2e/antigravity-browser.mjs"), harness.url, thread,
                marker if live else "RELAY_AGY_RESUMED", "deny", request["id"],
            ], cwd=ROOT, check=True, timeout=30)
        else:
            harness.post(f"/threads/{thread}/permission-requests/{request['id']}", {"decision": "deny"}, 200)
        reviewed, third = _settled(harness, thread, 3)
        assert not reviewed.get("permissionRequests")
        assert reviewed["permissionDecisions"][-1]["decision"] == "deny"

        if not live:
            assert "RELAY_AGY_DENIED" in _reply(third)
            assert first["tokenUsage"]["input"] == 13
            assert first["tokenUsage"]["cacheRead"] == 70
            [cwd] = (tmp_path / "workspace" / ".threads").iterdir()
            _send(harness, thread, "RELAY_AGY_WAIT_FOR_STEER")
            eventually(lambda: "RELAY_AGY_WORKING" in json.dumps(harness.session(thread)["events"]))
            if browser:
                subprocess.run([
                    "node", str(ROOT / "web/e2e/antigravity-browser.mjs"), harness.url, thread,
                    "RELAY_AGY_WORKING", "steer", "RELAY_AGY_STEER",
                ], cwd=ROOT, check=True, timeout=30)
            else:
                queue = f"/threads/{thread}/queue"
                harness.post(queue, {"action": "enqueue", "id": "steer-test", "text": "RELAY_AGY_STEER",
                                     "addressAgentIds": [harness.agent["id"]]}, 200)
                harness.post(queue, {"action": "steer", "id": "steer-test"}, 200)

            def steered():
                state = harness.session(thread)
                assert len(state["agentRuns"]) == 4 and state["agentRuns"][-1]["status"] == "running"
                return next((event for event in state["events"] if event["type"] == "user.live_message"), None)

            message = eventually(steered, timeout=15)
            assert (message["text"], message["delivery"]) == ("RELAY_AGY_STEER", "steer")
            (cwd / ".release-steered-turn").touch()
            _, redirected = _settled(harness, thread, 4)
            assert redirected["id"] == message["runId"]
            assert "RELAY_AGY_STEERED" in _reply(redirected)
            (cwd / ".discard-conversation").touch()
            recovered, fallback = _turn(harness, thread, "RELAY_AGY_FOLLOW_UP", 5)
            assert "RELAY_AGY_FALLBACK" in _reply(fallback)
            assert fallback["runtimeSessionId"] != conversation
            outputs = [event for event in recovered["events"] if event["type"].startswith("agent.output")]
            assert "Conversation not found" not in json.dumps(outputs)
            _, failed = _turn(harness, thread, "RELAY_AGY_FAILURE", 6, status="failed")
            assert failed["exitCode"] == 1
            assert "Provider refused the run" in failed["agentLog"]
    finally:
        harness.close()
