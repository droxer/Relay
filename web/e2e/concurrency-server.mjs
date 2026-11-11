// Real backend and daemon; only the third-party agent CLI is controlled.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { localProcessExecStream, runRelayDaemon } from "relay-daemon";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(join(tmpdir(), "relay-concurrency-e2e-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const port = process.env.RELAY_CONCURRENCY_E2E_PORT ?? "5128";
const backendUrl = `http://127.0.0.1:${port}`;
const stop = new AbortController();
const backend = spawn("uv", ["run", "--project", "backend", "--extra", "dev", "python", "-c", `
import os, uvicorn
from relay.core.logging_config import setup_logging
from relay.app import create_app
setup_logging(level='WARNING')
uvicorn.run(create_app(os.environ['RELAY_E2E_ROOT']), host='127.0.0.1', port=int(os.environ['RELAY_E2E_PORT']), log_level='warning')
`], {
  cwd: repo,
  env: {
    ...process.env, PYTHONPATH: join(repo, "backend"), UV_CACHE_DIR: join(repo, ".uv-cache"),
    RELAY_E2E_ROOT: root, RELAY_E2E_PORT: port,
    RELAY_DATABASE_URL: `sqlite:///${join(root, "backend.db")}`,
    DATABASE_URL: `sqlite:///${join(root, "backend.db")}`,
    RELAY_ADMIN_TOKEN: "concurrency-e2e-bootstrap", RELAY_STARTUP_REPAIRS: "0",
    RELAY_WEB_UI_DIST_DIR: join(repo, "web/out"), RELAY_BACKGROUND_MODE: "embedded",
    RELAY_TASK_SCHEDULER_ENABLED: "1", RELAY_TASK_SCHEDULER_INTERVAL_SECONDS: "0.1",
    RELAY_TASK_WIP_LIMIT: "5",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const backendExited = new Promise(resolve => backend.once("exit", resolve));
let daemon;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  stop.abort();
  await daemon?.catch(() => undefined);
  backend.kill("SIGTERM");
  await backendExited;
  await rm(root, { recursive: true, force: true });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => void close());

try {
  let ready = false;
  for (let attempt = 0; attempt < 150 && !stop.signal.aborted; attempt++) {
    if (backend.exitCode !== null) throw new Error("Concurrency backend exited during startup");
    try { ready = (await fetch(`${backendUrl}/api/v1/auth/status`)).ok; } catch { /* Starting. */ }
    if (ready) break;
    await delay(100);
  }
  if (!ready) throw new Error("Concurrency backend did not start");
  const bootstrap = await fetch(`${backendUrl}/api/v1/auth/bootstrap`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "concurrency-e2e-bootstrap", username: "concurrency", password: "kestrel-vault-7719" }),
  });
  if (!bootstrap.ok) throw new Error(`Bootstrap failed: ${await bootstrap.text()}`);
  const cookie = bootstrap.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const account = await bootstrap.json();
  const provision = await fetch(`${backendUrl}/api/v1/admin/daemon-nodes`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ userId: account.user.userId, sandboxMode: "none", nodeLocation: "user-device", workspacePath: workspace }),
  });
  if (!provision.ok) throw new Error(`Provision failed: ${await provision.text()}`);
  const { node, nodeToken } = await provision.json();
  const agentScript = join(root, "agent.cjs");
  // A real, cancellable child process. No model credentials or network calls.
  await writeFile(agentScript, `
const { mkdirSync, writeFileSync } = require('node:fs');
mkdirSync('.relay', { recursive: true });
writeFileSync('.relay/e2e-agent-started', String(process.pid));
writeFileSync('.relay/e2e-workspace-scope.json', JSON.stringify({cwd:process.cwd(),scope:JSON.parse(process.env.RELAY_WORKSPACE_SCOPE || '{}')}));
console.log(JSON.stringify({type:'thread.started',thread_id:'e2e-'+process.pid}));
setInterval(() => {}, 1000);
`);
  const execution = {
    ensureAgentReady: async () => undefined,
    execStream: (_command, _args, options) => localProcessExecStream(process.execPath, [agentScript], options),
    release() {},
  };
  daemon = runRelayDaemon({
    backendUrl, sandboxId: node.id, userId: account.user.userId, token: nodeToken,
    workspacePath: workspace, workspaceId: "concurrency-e2e-host",
    stateDir: join(root, "daemon"), agentHome: join(root, "agent-home"),
    sandbox: "none", maxConcurrentRuns: 2, pollIntervalMs: 20, commandPollWaitMs: 100,
    signal: stop.signal, echoAgentOutput: false, shutdownGraceMs: 2000,
    environment: {
      sandboxMode: "none",
      async ensureAgentReady(agent) { if (agent !== "codex") throw new Error("Only controlled Codex is installed"); },
      async execStream() { return { exit_code: 0, stdout: "", stderr: "" }; },
      async acquireWorkspace() { return execution; },
      async close() {},
    },
  });
  await daemon;
} finally {
  await close();
}
