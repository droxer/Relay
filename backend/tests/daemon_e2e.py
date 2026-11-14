"""Real loopback HTTP and TypeScript daemon; only Agent Runtime is deterministic."""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from uuid import uuid4

import httpx
import uvicorn

from relay.app import create_app
from relay.core.computer_identity import computer_id
from user_ids import user_id
from daemon_connection_gate import ConnectionGate

ROOT = Path(__file__).resolve().parents[2]


def eventually(check, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {check}")


class DaemonE2E:
    def __init__(self, root, monkeypatch, *, daemon_options=None):
        self.root = root
        self.daemon_options = daemon_options or {}
        for key, value in {"RELAY_ADMIN_TOKEN": "e2e-admin-token", "RELAY_TASK_SCHEDULER_ENABLED": "0",
                           "RELAY_STARTUP_REPAIRS": "0"}.items():
            monkeypatch.setenv(key, value)
        self.app = create_app(str(root))
        self.ctx = self.app.state.context
        self.start_server()
        self.client = httpx.Client(base_url=self.url, timeout=20)
        self.process = None
        self.log = None

    def start_server(self, port=0):
        self.gate = ConnectionGate(self.app)
        self.socket = socket.socket()
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(("127.0.0.1", port))
        self.port = self.socket.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.server = uvicorn.Server(uvicorn.Config(self.gate, log_level="error", timeout_graceful_shutdown=1))
        self.thread = threading.Thread(target=self.server.run, kwargs={"sockets": [self.socket]}, daemon=True)
        self.thread.start()
        eventually(lambda: self.server.started)

    def stop_server(self):
        self.gate.fault = None
        self.server.should_exit = True
        self.thread.join(timeout=15)
        assert not self.thread.is_alive(), "Test server did not stop"
        self.socket.close()

    def restart_server(self):
        self.app = create_app(str(self.root))
        self.ctx = self.app.state.context
        self.start_server(self.port)

    def setup(self):
        self.post("/auth/bootstrap", {"token": "e2e-admin-token", "username": "admin", "email": "admin@example.com", "password": "e2e-test-password-123"}, 200)
        self.post("/admin/users", {"userId": "alice", "username": "alice", "email": "alice@example.com", "password": "userpass", "displayName": "Alice"}, 201)
        owner = user_id("alice")
        self.node_id = str(uuid4())
        workspace = self.root / "workspace"
        workspace.mkdir()
        self.profile = {"url": self.url, "nodeId": self.node_id, "token": str(uuid4()),
                        "workspaceId": str(uuid4()), "workspace": str(workspace), "root": str(self.root),
                        "daemonOptions": self.daemon_options}
        node = self.ctx.registry.register({"sandboxId": self.node_id, "userId": owner,
            "token": self.profile["token"], "protocolVersion": 2, "supportedAgents": ["codex"],
            "capabilities": ["workspace-scope", "thread-workspaces", "project-workspaces", "durable-reports"],
            "workspacePath": str(workspace), "workspaceId": self.profile["workspaceId"], "status": "ready"})
        (self.root / "profile.json").write_text(json.dumps(self.profile))
        self.start_daemon()
        eventually(lambda: any(item["kind"] == "registered" for item in self.traces()))
        self.agent = self.post("/admin/agents", {"supervisorUserId": owner, "displayName": "E2E Agent",
            "executorKind": "codex", "defaultRole": "implementer", "computerId": computer_id(node)}, 201)["agent"]
        self.post("/auth/logout", {}, 200)
        self.post("/auth/login", {"username": "alice", "password": "userpass"}, 200)
        self.project = self.post("/projects", {"name": "Report E2E", "daemonNodeId": self.node_id,
            "leadAgentId": self.agent["id"], "members": [{"agentId": self.agent["id"], "role": "implementer",
            "responsibilities": "Exercise report lifecycle"}]}, 201)["project"]

    def post(self, path, body, status):
        response = self.client.post("/api/v1" + path, json=body)
        assert response.status_code == status, response.text
        return response.json()

    def start_daemon(self):
        env = {key: value for key, value in os.environ.items() if not key.startswith("RELAY_") and key != "DATABASE_URL"}
        self.log = (self.root / "daemon.log").open("a")
        self.process = subprocess.Popen(["node", str(ROOT / "packages/relay-daemon/tests/fixtures/report-e2e.mjs"),
            str(self.root / "profile.json")], cwd=ROOT, env=env, stdout=self.log, stderr=self.log)

    def stop_daemon(self):
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.log.close()
            self.process = None

    def close(self):
        self.stop_daemon()
        self.client.close()
        self.stop_server()

    def traces(self):
        path = self.root / "trace.jsonl"
        if not path.exists():
            return []
        # Polling races with the daemon's append: only newline-terminated
        # records are committed, and the unfinished tail may split UTF-8.
        return [json.loads(line) for line in path.read_bytes().split(b"\n")[:-1]]

    def start_task(self):
        task = self.post("/tasks", {"title": "Report lifecycle E2E", "assignedAgentId": self.agent["id"], "projectId": self.project["id"],
            "acceptancePolicy": "automatic"}, 201)
        started = self.post(f"/tasks/{task['id']}/runs", {}, 202)
        return task["id"], started["session"]["id"]

    def session(self, session_id):
        response = self.client.get(f"/api/v1/threads/{session_id}")
        assert response.status_code == 200, response.text
        return response.json()

    def settled(self, session_id, launches, status="completed"):
        def check():
            runs = [item for item in self.traces() if item["kind"] == "launch" and item["sessionId"] == session_id]
            session = self.session(session_id)
            return session if len(runs) == launches and session["status"] == status else None
        session = eventually(check)
        eventually(lambda: not list((self.root / "state").rglob("terminal-events/*.json")))
        assert not list((self.root / "state").rglob("*.rejected"))
        return session

    def follow_up(self, session_id, text="Continue in the completed task thread"):
        return self.post(f"/threads/{session_id}/messages", {"text": text, "intent": "accomplish"}, 202)

    def fault(self, kind):
        (self.root / "faults.json").write_text(json.dumps({"id": str(uuid4()), "kind": kind}))
