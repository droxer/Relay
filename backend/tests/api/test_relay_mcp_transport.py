"""Real HTTP/stdio interoperability against the hosted Python MCP application."""

import asyncio
from datetime import timedelta
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import shutil
from threading import Thread

import httpx
import pytest
from fastapi.testclient import TestClient
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
import test_project_manager_api as manager_api
import test_project_setup_api as setup_api
from test_relay_mcp_api import _token
from test_project_manager_api import _start

setup_env = setup_api.setup_env
managed_env = manager_api.managed_env
ROOT = Path(__file__).resolve().parents[3]
NODE_BRIDGE = ROOT / "dist/packages/relay-daemon/src/relay-mcp.js"
requires_node_bridge = pytest.mark.skipif(
    shutil.which("node") is None or not NODE_BRIDGE.exists(),
    reason="Build TypeScript packages and install Node to exercise local-runtime interoperability.",
)


@contextmanager
def _http_transport(app):
    # TestClient owns the real app/SDK lifespan; this socket adapter gives the
    # official MCP client and Node subprocess a real HTTP transport to it.
    with TestClient(app) as client:

        class Handler(BaseHTTPRequestHandler):
            def _forward(self):
                content = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                reply = client.request(self.command, self.path, content=content, headers=dict(self.headers))
                self.send_response(reply.status_code)
                for key, value in reply.headers.items():
                    if key.lower() not in ("content-length", "transfer-encoding", "connection", "content-encoding"):
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(reply.content)))
                self.end_headers()
                self.wfile.write(reply.content)

            do_POST = do_GET = do_DELETE = _forward

            def log_message(self, _format, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.daemon_threads = True
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)


def test_official_mcp_client_discovers_and_calls_hosted_tools(managed_env):
    app, owner, _, project, *_ = managed_env
    grant = _token(owner, project)
    with _http_transport(app) as url:

        async def call():
            async with httpx.AsyncClient(headers={"Authorization": f"Bearer {grant['token']}"}) as http:
                async with streamable_http_client(url + "/api/v1/mcp", http_client=http) as (read, write, _):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=10)) as session:
                        initialized = await session.initialize()
                        assert initialized.serverInfo.name == "relay-projects"
                        catalog = await session.list_tools()
                        assert len(catalog.tools) == 9
                        result = await session.call_tool("relay_project_overview", {"projectId": project["id"]})
                        assert result.isError is False
                        assert result.structuredContent["project"]["id"] == project["id"]

        asyncio.run(call())


@requires_node_bridge
@pytest.mark.integration
def test_real_local_node_bridge_round_trips_to_python_with_scope_enforced(setup_env, tmp_path):
    app, owner, node, project, *_ = setup_env
    grant = _token(owner, project)
    other = owner.post("/api/v1/projects", json={"name": "Another", "daemonNodeId": node["id"], "members": []}).json()[
        "project"
    ]
    script = ROOT / "dist/packages/relay-daemon/src/relay-mcp.js"
    assert script.exists(), "Build the TypeScript packages before the integration test."
    token_file = tmp_path / "mcp.token"
    token_file.write_text(grant["token"])
    token_file.chmod(0o600)
    with _http_transport(app) as url:
        config = tmp_path / "mcp.json"
        config.write_text(json.dumps({"backendUrl": url, "tokenFile": str(token_file)}))
        messages = [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "real-local-runtime", "version": "1"},
                },
            },
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            *[
                {
                    "jsonrpc": "2.0",
                    "id": i + 3,
                    "method": "tools/call",
                    "params": {"name": "relay_project_overview", "arguments": {"projectId": p["id"]}},
                }
                for i, p in enumerate([project, other])
            ],
        ]
        process = subprocess.run(
            ["node", str(script), "--config", str(config)],
            input="\n".join(json.dumps(m) for m in messages) + "\n",
            text=True,
            capture_output=True,
            timeout=30,
            cwd=ROOT,
            # This case uses standalone credentials, not the enclosing Agent's
            # managed run transport. Managed cases supply their own context below.
            env={**os.environ, "RELAY_MCP_RUN_CONTEXT": ""},
            check=False,
        )
        assert process.returncode == 0, process.stderr
        replies = sorted((json.loads(line) for line in process.stdout.splitlines()), key=lambda reply: reply["id"])
        assert len(replies) == 4
        assert len(replies[1]["result"]["tools"]) == 9
        assert replies[2]["result"]["structuredContent"]["project"]["id"] == project["id"]
        assert replies[3]["result"]["isError"] is True
        assert grant["token"] not in process.stdout + process.stderr


def test_hosted_run_token_preserves_agent_and_expires_when_command_ends(managed_env):
    app, owner, node, project, *_ = managed_env
    result, command = _start(managed_env)
    external = TestClient(app)
    issued = external.post(
        f"/api/v1/daemon-nodes/{node['id']}/mcp-token",
        headers={"Authorization": f"Bearer token_{node['id']}"},
        json={"commandId": command["id"], "leaseId": command["leaseId"]},
    )
    assert issued.status_code == 201, issued.text
    from test_relay_mcp_protocol import _rpc

    with TestClient(app) as client:
        staged = _rpc(
            client,
            issued.json()["token"],
            "tools/call",
            {
                "name": "relay_propose_task_changes",
                "arguments": {
                    "projectId": project["id"],
                    "operations": [{"kind": "create", "fields": {"title": "Hosted Python proposal"}}],
                },
            },
        )
        assert staged.status_code == 200, staged.text
        proposal = staged.json()["result"]["structuredContent"]["proposal"]
        assert proposal["agentId"] == command["logicalAgentId"]
        assert proposal["runId"] == command["runId"]
        assert owner.get("/api/v1/tasks").json()["tasks"] == []
        setup_api._complete(app, node, command, result["threadId"])
        assert _rpc(client, issued.json()["token"], "tools/list").status_code == 401


@requires_node_bridge
@pytest.mark.integration
@pytest.mark.parametrize("native", [False, True], ids=["file", "native-ipc"])
def test_managed_node_bridge_uses_a_daemon_held_run_token_against_python(managed_env, tmp_path, native):
    app, owner, node, project, *_ = managed_env
    result, command = _start(managed_env)
    other = owner.post(
        "/api/v1/projects", json={"name": "Other managed scope", "daemonNodeId": node["id"], "members": []}
    ).json()["project"]
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config = tmp_path / "mcp.json"
    sources = ROOT / "dist/packages/relay-daemon/src"
    script = r"""
import {createProjectManagerBridge} from './dist/packages/relay-daemon/src/project-manager.js';
import {createRunMcpProxy} from './dist/packages/relay-daemon/src/relay-mcp-managed.js';
import {startNativeMcpBridge} from './dist/packages/relay-daemon/src/relay-mcp-native.js';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
const settings=JSON.parse(process.env.RELAY_MCP_TEST_HOST);
delete process.env.RELAY_MCP_TEST_HOST;
const proxy=createRunMcpProxy({...settings,fetchFn:fetch,signal:new AbortController().signal});
const bridge=createProjectManagerBridge(settings.workspace,proxy);
const native=settings.native ? await startNativeMcpBridge(proxy) : undefined;
try{
 const child=spawn(process.execPath,[join(settings.sources,'relay-mcp.js'),'--config',settings.config],{env:{...process.env,RELAY_MCP_RUN_CONTEXT:JSON.stringify({backendUrl:settings.backendUrl,projectId:settings.projectId,bridgePath:join(settings.workspace,bridge.toolPath),native:native?.address})},stdio:['pipe','inherit','inherit']});
 process.stdin.pipe(child.stdin);
 process.exitCode=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
}finally{await native?.dispose();await bridge.dispose();}
"""
    with _http_transport(app) as url:
        config.write_text(json.dumps({"backendUrl": url, "tokenFile": str(tmp_path / "no-standalone-token")}))
        messages = [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "managed-local", "version": "1"},
                },
            },
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "relay_project_overview", "arguments": {"projectId": other["id"]}},
            },
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "relay_propose_task_changes",
                    "arguments": {
                        "projectId": project["id"],
                        "operations": [{"kind": "create", "fields": {"title": "Daemon proxy to Python"}}],
                    },
                },
            },
        ]
        host = {
            "native": native,
            "backendUrl": url,
            "sandboxId": node["id"],
            "nodeToken": f"token_{node['id']}",
            "commandId": command["id"],
            "leaseId": command["leaseId"],
            "projectId": project["id"],
            "workspace": str(workspace),
            "sources": str(sources),
            "config": str(config),
        }
        process = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            input="\n".join(json.dumps(m) for m in messages) + "\n",
            text=True,
            capture_output=True,
            cwd=ROOT,
            timeout=30,
            env={**os.environ, "RELAY_MCP_TEST_HOST": json.dumps(host)},
            check=False,
        )
        assert process.returncode == 0, process.stderr
        replies = sorted((json.loads(line) for line in process.stdout.splitlines()), key=lambda reply: reply["id"])
        assert len(replies) == 3
        assert replies[1]["result"]["isError"] is True
        proposal = replies[2]["result"]["structuredContent"]["proposal"]
        assert proposal["agentId"] == command["logicalAgentId"]
        assert proposal["runId"] == command["runId"]
        assert host["nodeToken"] not in process.stdout + process.stderr
        assert all(host["nodeToken"] not in p.read_text() for p in workspace.rglob("*") if p.is_file())
        assert owner.get("/api/v1/tasks").json()["tasks"] == []
        setup_api._complete(app, node, command, result["threadId"])
