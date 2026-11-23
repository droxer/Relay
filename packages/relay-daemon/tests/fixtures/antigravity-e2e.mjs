import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runRelayDaemon } from "../../dist/index.js";
import { createLocalRuntime } from "../../dist/local-runtime.js";
import { AgentNotInstalledError } from "../../dist/agent-preflight.js";

const profile = JSON.parse(readFileSync(process.argv[2], "utf8"));
const origin = new URL(profile.url);
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") {
  throw new Error("E2E requires a disposable loopback backend.");
}

const trace = (kind, fields = {}) => appendFileSync(
  join(profile.root, "trace.jsonl"),
  JSON.stringify({ kind, ...fields }) + "\n",
);
const stop = new AbortController();
const runtime = createLocalRuntime();
process.on("SIGTERM", () => stop.abort());
process.on("SIGINT", () => stop.abort());
await runRelayDaemon({
  backendUrl: profile.url,
  sandboxId: profile.nodeId,
  token: profile.token,
  workspaceId: profile.workspaceId,
  workspacePath: profile.workspace,
  stateDir: join(profile.root, "state"),
  sandbox: "none",
  // The production process adapter uses the real CLI. Avoid installing
  // standalone MCP configuration in the account running the live smoke test.
  environment: {
    ...runtime,
    ensureAgentReady(agent, signal) {
      if (agent !== "antigravity") throw new AgentNotInstalledError("Only Antigravity is enabled in this fixture.");
      return runtime.ensureAgentReady(agent, signal);
    },
  },
  signal: stop.signal,
  pollIntervalMs: 20,
  echoAgentOutput: false,
  ...profile.daemonOptions,
  async fetchFn(url, init) {
    const response = await fetch(url, init);
    const path = new URL(String(url)).pathname;
    if (response.ok && path.endsWith("/daemon-node-registrations")) trace("registered");
    if (response.ok && path.endsWith("/commands")) {
      for (const command of (await response.clone().json()).commands ?? []) {
        if (command.type === "run.start") {
          trace("dispatch", { resume: command.state.resume_session_id, model: command.state.agent_model });
        }
      }
    }
    return response;
  },
  logger: {
    info: (message, fields) => trace("info", { message, ...fields }),
    warn: (message, fields) => trace("warn", { message, ...fields }),
    error: (message, fields) => trace("error", { message, ...fields }),
    output: () => {},
  },
});
