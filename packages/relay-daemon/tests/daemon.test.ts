import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";

import {
  backendReconnectDelayMs,
  collectExecution,
  createDaemonLogger,
  discoverAgentInventory,
  localProcessExecStream,
  parseInventoryOutput,
  resolveBoxliteHome,
  resolveSandboxMode,
  runRelayDaemon,
  runRelayDaemonDoctor,
  shutdownBoxliteRuntime,
  type DaemonExecutionEnvironment,
  type DaemonLogger,
} from "../src/index.js";

const previousDaemonStateDir = process.env.RELAY_DAEMON_STATE_DIR;
const testDaemonStateDir = mkdtempSync(join(tmpdir(), "relay-daemon-private-state-"));
process.env.RELAY_DAEMON_STATE_DIR = testDaemonStateDir;
after(() => {
  if (previousDaemonStateDir === undefined) delete process.env.RELAY_DAEMON_STATE_DIR;
  else process.env.RELAY_DAEMON_STATE_DIR = previousDaemonStateDir;
  rmSync(testDaemonStateDir, { recursive: true, force: true });
});
import { acquireBoxliteHomeLock } from "../src/box.js";
import { agentWorkspaceSubpath } from "../src/agent-workspace.js";
import { listWorkspace, readWorkspaceFile, WorkspaceReadError } from "../src/workspace-read.js";
import { isMainModule } from "../src/cli.js";
import { consumeRoundResult, ROUND_RESULT_RELATIVE_PATH } from "../src/round-result.js";
import type { DaemonNodeCommand, DaemonNodeEvent, DaemonNodeRegistration, DaemonNodeRunCommand, StreamExecResult } from "relay-core";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function testLogger(): DaemonLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    output: () => undefined,
  };
}

function fakeEnvironment(input: {
  exec?: DaemonExecutionEnvironment["execStream"];
  ensure?: DaemonExecutionEnvironment["ensureAgentReady"];
} = {}): DaemonExecutionEnvironment {
  return {
    sandboxMode: "none",
    ensureAgentReady: input.ensure ?? (async () => undefined),
    execStream: input.exec ?? (async (_cmd, _args, options): Promise<StreamExecResult> => {
      // Mirror collectExecution: raw chunks go through the stdout renderer
      // (which is what surfaces run.output events), the rendered text to the sink.
      const rendered = options?.stdoutRenderer?.("done\n") ?? "done\n";
      options?.sink?.(rendered);
      return { exit_code: 0, stdout: "done\n", stderr: "" };
    }),
    close: async () => undefined,
  };
}

function captureEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreCapturedEnv(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) restoreEnv(key, value);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function runCommand(id = "cmd_1"): DaemonNodeRunCommand {
  return {
    id,
    type: "run.start",
    sessionId: "ses_1",
    runId: "run_1",
    taskGoal: "do work",
    agent: "codex",
    assignmentId: "assignment_1",
    phase: "execution",
    delivery: {
      type: "assignment-attempt",
      attemptId: "run_1",
      collaborationId: "col_1",
      roundId: "round_1",
      assignmentId: "assignment_1",
      workItemId: "assignment_1",
    },
    workspacePath: process.cwd(),
    workspaceLayout: "thread",
  };
}

function isInventoryProbe(args: string[] | undefined): boolean {
  return Boolean(args?.[1]?.includes("printf 'SKILL"));
}

test("relay daemon recognizes an npm-style symlink as its CLI entrypoint", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-daemon-cli-"));
  try {
    const cliPath = new URL("../src/cli.js", import.meta.url);
    const binPath = join(root, "relay-daemon");
    symlinkSync(cliPath, binPath);
    assert.equal(isMainModule(cliPath.href, binPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay daemon defaults to BoxLite sandbox mode unless none is explicit", () => {
  assert.equal(resolveSandboxMode(undefined), "boxlite");
  assert.equal(resolveSandboxMode(""), "boxlite");
  assert.equal(resolveSandboxMode("none"), "none");
});

test("BoxLite home is isolated from the global default and stable per workspace", () => {
  const workspace = "/tmp/relay workspace";

  const resolved = resolveBoxliteHome(workspace, undefined);

  assert.match(resolved, /\/\.relay\/boxlite\/[a-f0-9]{12}$/);
  assert.notEqual(resolved, `${process.env.HOME}/.boxlite`);
  assert.equal(resolveBoxliteHome(workspace, resolved), resolved);
});

test("BoxLite home leaves room for runtime sockets in managed workspaces", () => {
  const workspace = join(
    process.cwd(),
    ".relay",
    "employee-workspaces",
    "5dadd571-0557-4288-8378-90af89b20c6e",
  );

  const resolved = resolveBoxliteHome(workspace, undefined);
  const otherWorkspace = resolveBoxliteHome(
    join(process.cwd(), ".relay", "employee-workspaces", "b10e0f0d-70d6-4b61-8249-bf9582d45480"),
    undefined,
  );
  const readySocket = join(resolved, "boxes", "Te1OnCQiUQlF", "sockets", "ready.sock");

  assert.notEqual(resolved, otherWorkspace);
  assert.ok(
    Buffer.byteLength(readySocket) < 104,
    `BoxLite ready socket exceeds the macOS Unix socket path limit: ${readySocket}`,
  );
});

test("BoxLite home locks allow different homes at the same time", async (t: TestContext) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const root = mkdtempSync(joinPath(tmpdir(), "relay-boxlite-locks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = acquireBoxliteHomeLock(joinPath(root, "one"));
  const second = acquireBoxliteHomeLock(joinPath(root, "two"));
  t.after(() => first.release());
  t.after(() => second.release());

  assert.notEqual(first.lockDir, second.lockDir);
});

test("BoxLite home lock rejects another live owner of the same home", async (t: TestContext) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const root = mkdtempSync(joinPath(tmpdir(), "relay-boxlite-lock-busy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const lock = acquireBoxliteHomeLock(root);
  t.after(() => lock.release());

  assert.throws(
    () => acquireBoxliteHomeLock(root),
    /Another Relay orchestrator is already running:[\s\S]+only one BoxLite runtime can use/,
  );
});

test("BoxLite home lock reclaims stale owners", async (t: TestContext) => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const root = mkdtempSync(joinPath(tmpdir(), "relay-boxlite-lock-stale-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const lockDir = joinPath(root, ".relay-boxlite.lock");
  mkdirSync(lockDir);
  writeFileSync(joinPath(lockDir, "owner.json"), JSON.stringify({
    pid: -1,
    token: "stale",
    command: "stale relay-daemon",
  }));

  const lock = acquireBoxliteHomeLock(root);
  t.after(() => lock.release());

  assert.equal(lock.lockDir, lockDir);
});

test("BoxLite runtime shutdown releases native state before closing", async () => {
  const calls: string[] = [];
  await shutdownBoxliteRuntime({
    async shutdown() {
      calls.push("shutdown");
    },
    close() {
      calls.push("close");
    },
  });

  assert.deepEqual(calls, ["shutdown", "close"]);
});

test("BoxLite runtime still closes when graceful shutdown fails", async () => {
  const calls: string[] = [];
  await assert.rejects(
    shutdownBoxliteRuntime({
      async shutdown() {
        calls.push("shutdown");
        throw new Error("shutdown failed");
      },
      close() {
        calls.push("close");
      },
    }),
    /shutdown failed/,
  );

  assert.deepEqual(calls, ["shutdown", "close"]);
});

test("BoxLite mode clears local agent process flags", async () => {
  const previousRunAs = process.env.RELAY_RUN_AS_CURRENT_USER;
  const previousAgentHome = process.env.RELAY_AGENT_HOME;
  const stop = new AbortController();
  stop.abort();
  process.env.RELAY_RUN_AS_CURRENT_USER = "1";
  process.env.RELAY_AGENT_HOME = "/tmp/relay-host-home";
  try {
    await runRelayDaemon({
      backendUrl: "http://relay.test",
      sandboxId: "sbx_boxlite_env",
      employeeId: "alice",
      workspacePath: process.cwd(),
      token: "node_token",
      logger: testLogger(),
      signal: stop.signal,
      environment: fakeEnvironment(),
    });

    assert.equal(process.env.RELAY_RUN_AS_CURRENT_USER, undefined);
    assert.equal(process.env.RELAY_AGENT_HOME, undefined);
  } finally {
    restoreEnv("RELAY_RUN_AS_CURRENT_USER", previousRunAs);
    restoreEnv("RELAY_AGENT_HOME", previousAgentHome);
  }
});

test("local node mode detects agents from the employee host home by default", async () => {
  const previous = captureEnv(["RELAY_AGENT_HOME", "RELAY_RUN_AS_CURRENT_USER"]);
  const stop = new AbortController();
  stop.abort();
  delete process.env.RELAY_AGENT_HOME;
  try {
    await runRelayDaemon({
      backendUrl: "http://relay.test",
      sandboxId: "sbx_local_env",
      employeeId: "alice",
      workspacePath: process.cwd(),
      sandbox: "none",
      token: "node_token",
      logger: testLogger(),
      signal: stop.signal,
      environment: fakeEnvironment(),
    });

    assert.equal(process.env.RELAY_RUN_AS_CURRENT_USER, "1");
    assert.equal(process.env.RELAY_AGENT_HOME, homedir());
  } finally {
    restoreCapturedEnv(previous);
  }
});

test("local process execution strips daemon tokens from agent subprocess env", async () => {
  const previous = captureEnv([
    "DATABASE_URL",
    "RELAY_AGENT_HOME",
    "RELAY_AUTH_STORE",
    "RELAY_BACKEND_URL",
    "RELAY_DATABASE_URL",
    "RELAY_DAEMON_NODE_TOKEN",
    "RELAY_DAEMON_UI_TOKEN",
    "RELAY_ADMIN_TOKEN",
    "RELAY_TASK_SCHEDULER_ENABLED",
  ]);
  const agentHome = "/tmp/relay-agent-home-test";
  process.env.DATABASE_URL = "postgres://user:secret@localhost/relay";
  process.env.RELAY_AGENT_HOME = agentHome;
  process.env.RELAY_AUTH_STORE = "database";
  process.env.RELAY_BACKEND_URL = "http://backend.test";
  process.env.RELAY_DATABASE_URL = "postgres://user:relay_secret@localhost/relay";
  process.env.RELAY_DAEMON_NODE_TOKEN = "node_secret";
  process.env.RELAY_DAEMON_UI_TOKEN = "ui_secret";
  process.env.RELAY_ADMIN_TOKEN = "admin_secret";
  process.env.RELAY_TASK_SCHEDULER_ENABLED = "1";
  try {
    const script = [
      "console.log(JSON.stringify({",
      "home: process.env.HOME,",
      "codexHome: process.env.CODEX_HOME,",
      "databaseUrl: process.env.DATABASE_URL || null,",
      "relayAuthStore: process.env.RELAY_AUTH_STORE || null,",
      "backendUrl: process.env.RELAY_BACKEND_URL || null,",
      "relayDatabaseUrl: process.env.RELAY_DATABASE_URL || null,",
      "nodeToken: process.env.RELAY_DAEMON_NODE_TOKEN || null,",
      "uiToken: process.env.RELAY_DAEMON_UI_TOKEN || null,",
      "adminToken: process.env.RELAY_ADMIN_TOKEN || null,",
      "taskSchedulerEnabled: process.env.RELAY_TASK_SCHEDULER_ENABLED || null",
      "}));",
    ].join("");
    const result = await localProcessExecStream(process.execPath, ["-e", script]);
    assert.equal(result.exit_code, 0, result.stderr || result.error_message);
    const env = JSON.parse(result.stdout) as Record<string, string | null>;
    assert.equal(env.home, agentHome);
    assert.equal(env.codexHome, `${agentHome}/.codex`);
    assert.equal(env.databaseUrl, null);
    assert.equal(env.relayAuthStore, null);
    assert.equal(env.backendUrl, null);
    assert.equal(env.relayDatabaseUrl, null);
    assert.equal(env.nodeToken, null);
    assert.equal(env.uiToken, null);
    assert.equal(env.adminToken, null);
    assert.equal(env.taskSchedulerEnabled, null);
  } finally {
    restoreCapturedEnv(previous);
  }
});

test("local process execution preserves UTF-8 split across chunks", async () => {
  const stdout = "你好，Relay\n";
  const stderr = "错误输出\n";
  const script = `
    const stdout = Buffer.from(${JSON.stringify(stdout)});
    const stderr = Buffer.from(${JSON.stringify(stderr)});
    process.stdout.write(stdout.subarray(0, 1));
    setTimeout(() => process.stdout.write(stdout.subarray(1)), 10);
    process.stderr.write(stderr.subarray(0, 2));
    setTimeout(() => process.stderr.write(stderr.subarray(2)), 20);
  `;
  const rendered: string[] = [];

  const result = await localProcessExecStream(process.execPath, ["-e", script], {
    stdoutRenderer: (chunk) => `stdout:${chunk}`,
    stderrRenderer: (chunk) => `stderr:${chunk}`,
    sink: (text) => rendered.push(text),
  });

  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.equal(result.stdout.includes("\uFFFD"), false);
  assert.equal(result.stderr.includes("\uFFFD"), false);
  assert.equal(rendered.some((chunk) => chunk.includes("\uFFFD")), false);
  assert.equal(rendered.includes(`stdout:${stdout}`), true);
  assert.equal(rendered.includes(`stderr:${stderr}`), true);
});

test("collectExecution preserves UTF-8 split across byte chunks", async () => {
  const stdout = "你好，BoxLite\n";
  const stderr = "错误输出\n";
  const stdoutBytes = Buffer.from(stdout);
  const stderrBytes = Buffer.from(stderr);
  const stdoutChunks: Array<Buffer | null> = [stdoutBytes.subarray(0, 1), stdoutBytes.subarray(1), null];
  const stderrChunks: Array<Buffer | null> = [stderrBytes.subarray(0, 2), stderrBytes.subarray(2), null];
  const rendered: string[] = [];
  const execution = {
    stdout: async () => ({
      next: async () => stdoutChunks.shift() ?? null,
    }),
    stderr: async () => ({
      next: async () => stderrChunks.shift() ?? null,
    }),
    wait: async () => ({ exitCode: 0 }),
  };

  const result = await collectExecution(
    execution,
    true,
    (chunk) => `stdout:${chunk}`,
    (chunk) => `stderr:${chunk}`,
    (text) => rendered.push(text),
  );

  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
  assert.equal(rendered.includes(`stdout:${stdout}`), true);
  assert.equal(rendered.includes(`stderr:${stderr}`), true);
  assert.equal(rendered.some((chunk) => chunk.includes("\uFFFD")), false);
});

test("execution capture retains a bounded transcript tail", async () => {
  const output = `${"a".repeat(400_000)}terminal-jsonl\n`;
  const chunks: Array<string | null> = [output, null];
  const execution = {
    stdin: async () => ({ close: async () => undefined }),
    stdout: async () => ({ next: async () => chunks.shift() ?? null }),
    stderr: async () => ({ next: async () => null }),
    wait: async () => ({ exitCode: 0 }),
  };

  const result = await collectExecution(execution);

  assert.ok(result.stdout.length <= 262_144);
  assert.match(result.stdout, /terminal-jsonl\n$/);
});

test("local execution capture retains a bounded transcript tail", async () => {
  const result = await localProcessExecStream(process.execPath, [
    "-e",
    'process.stdout.write("a".repeat(400000) + "terminal-jsonl\\n")',
  ]);

  assert.equal(result.exit_code, 0);
  assert.ok(result.stdout.length <= 262_144);
  assert.match(result.stdout, /terminal-jsonl\n$/);
});

test("codex TOML inventory scopes keys to their own mcp_servers table", () => {
  const toml = [
    '[mcp_servers.docs]',
    'command = "docs-server"',
    '',
    '[mcp_servers.remote]',
    'url = "https://user:pw@mcp.example.com/sse?token=secret"',
    '',
    '[mcp_servers.literal]',
    "command = 'literal-server'",
    '',
    '[projects]',
    'command = "not-an-mcp-server"',
    'url = "https://not-an-mcp-server.example.com"',
  ].join("\n");

  const parsed = parseInventoryOutput(
    ["MCP", "codex", ".codex/config.toml", Buffer.from(toml).toString("base64")].join("\t"),
  );

  const servers = parsed.codex?.mcpServers ?? [];
  const byName = new Map(servers.map((server) => [server.name, server]));
  // `[projects]` keys stay out: leaving a table ends the current server.
  assert.deepEqual([...byName.keys()].sort(), ["docs", "literal", "remote"]);
  assert.equal(byName.get("docs")?.command, "docs-server");
  assert.equal(byName.get("literal")?.command, "literal-server");
  // Credentials and query strings are stripped before the server is reported.
  assert.equal(byName.get("remote")?.command, "https://mcp.example.com/sse");
});

test("local agent processes never inherit another provider's credentials", async () => {
  // A local node runs agents as daemon child processes, so anything left in the
  // daemon environment is inherited unless it is explicitly stripped.
  const providerEnv = {
    ANTHROPIC_API_KEY: "anthropic-secret",
    OPENAI_API_KEY: "openai-secret",
    CODEX_API_KEY: "codex-secret",
    PI_API_KEY: "pi-secret",
    KIMI_API_KEY: "kimi-secret",
    MOONSHOT_API_KEY: "moonshot-secret",
  };
  const previous = captureEnv(Object.keys(providerEnv));
  Object.assign(process.env, providerEnv);
  try {
    const result = await localProcessExecStream(process.execPath, [
      "-e",
      `console.log(JSON.stringify(${JSON.stringify(Object.keys(providerEnv))}.map((k) => [k, process.env[k] ?? null])))`,
    ], { env: { ANTHROPIC_API_KEY: "anthropic-secret" } });

    assert.equal(result.exit_code, 0);
    assert.deepEqual(JSON.parse(result.stdout), [
      ["ANTHROPIC_API_KEY", "anthropic-secret"],
      ["OPENAI_API_KEY", null],
      ["CODEX_API_KEY", null],
      ["PI_API_KEY", null],
      ["KIMI_API_KEY", null],
      ["MOONSHOT_API_KEY", null],
    ]);
  } finally {
    restoreCapturedEnv(previous);
  }
});

test("execution capture honors the documented transcript override", async () => {
  const previous = process.env.RELAY_AGENT_RESULT_LOG_LIMIT;
  process.env.RELAY_AGENT_RESULT_LOG_LIMIT = "600000";
  try {
    const result = await localProcessExecStream(process.execPath, [
      "-e",
      'process.stdout.write("a".repeat(400000) + "terminal-jsonl\\n")',
    ]);

    assert.equal(result.exit_code, 0);
    // Without the override this would have been clipped to 256 KiB upstream of
    // the completed-run log, making the documented knob a no-op.
    assert.equal(result.stdout.length, 400_000 + "terminal-jsonl\n".length);
  } finally {
    restoreEnv("RELAY_AGENT_RESULT_LOG_LIMIT", previous);
  }
});

test("relay daemon ignores duplicate run.start commands already active", async () => {
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let execCount = 0;
  let commandBatchServed = false;
  const command = runCommand();
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        // The startup agent-inventory sweep also runs through execStream; only
        // count actual agent runs so the duplicate-suppression assertion holds.
        if (!isInventoryProbe(args)) execCount += 1;
        options?.sink?.("done\n");
        return { exit_code: 0, stdout: "done\n", stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandBatchServed) {
          commandBatchServed = true;
          return jsonResponse({ commands: [command, command] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        events.push(await jsonBody<DaemonNodeEvent>(init));
        if (events.some((event) => event.type === "run.completed")) stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await daemon;

  assert.equal(execCount, 1);
  assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
});

test("relay daemon reports structured Codex collaboration events", async () => {
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let commandServed = false;
  const command = runCommand("cmd_collaboration");
  const item = JSON.stringify({
    type: "item.completed",
    item: {
      type: "collab_agent_tool_call",
      id: "collab-1",
      tool: "spawn_agent",
      status: "completed",
      sender_thread_id: "root-thread",
      receiver_thread_ids: ["child-thread"],
      prompt: "Review the changes",
      agents_states: { "child-thread": { status: "running", message: null } },
    },
  });
  await runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (!isInventoryProbe(args)) options?.stdoutRenderer?.(`${item}\n`);
        return { exit_code: 0, stdout: `${item}\n`, stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [command] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        events.push(event);
        if (event.type === "run.completed") stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const collaboration = events.find((event) => event.type === "run.collaboration");
  assert.ok(collaboration && collaboration.type === "run.collaboration");
  assert.equal(collaboration.collaboration.tool, "spawnAgent");
  assert.deepEqual(collaboration.collaboration.receiverThreadIds, ["child-thread"]);
});

test("relay daemon advertises active delivery leases while polling", async () => {
  const stop = new AbortController();
  const command = { ...runCommand("cmd_active_poll"), leaseId: "lease_1", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  let commandServed = false;
  let activePollSeen = false;
  let commandLeaseSeconds = 0;
  let leaseMode = "";
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    commandPollWaitMs: 25_000,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
        while (!activePollSeen) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        options?.sink?.("done\n");
        return { exit_code: 0, stdout: "done\n", stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        commandLeaseSeconds = Number(parsed.searchParams.get("leaseSeconds") ?? "0");
        leaseMode = parsed.searchParams.get("leaseMode") ?? "";
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [command] });
        }
        if (parsed.searchParams.get("activeCommandLease") === `${command.id}:${command.leaseId}`) activePollSeen = true;
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        if (event.type === "run.completed") stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await daemon;

  assert.equal(activePollSeen, true);
  assert.equal(leaseMode, "explicit");
  assert.equal(commandLeaseSeconds, 90);
});

test("relay daemon refreshes an active command lease from a duplicate dispatch", async () => {
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  const first = { ...runCommand("cmd_duplicate_lease"), leaseId: "lease_old", leaseExpiresAt: new Date(Date.now() + 1_000).toISOString(), attempt: 1 };
  const duplicate = { ...first, leaseId: "lease_new", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), attempt: 2 };
  let pollCount = 0;
  let duplicateServed = false;
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
        while (!duplicateServed) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        options?.sink?.("done\n");
        return { exit_code: 0, stdout: "done\n", stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        pollCount += 1;
        if (pollCount === 1) return jsonResponse({ commands: [first] });
        if (pollCount === 2) {
          duplicateServed = true;
          return jsonResponse({ commands: [duplicate] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        events.push(event);
        if (event.type === "run.completed") stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await daemon;

  const completed = events.find((event) => event.type === "run.completed");
  assert.equal(completed?.leaseId, "lease_new");
});

test("relay daemon advertises only agents with passing capability preflight", async () => {
  const stop = new AbortController();
  const registrations: DaemonNodeRegistration[] = [];
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    workspaceId: "repo:relay",
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      ensure: async (agent) => {
        if (agent === "kimi") throw new Error("Kimi is not logged in.");
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") {
        registrations.push(await jsonBody<DaemonNodeRegistration>(init));
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/commands")) {
        stop.abort();
        return jsonResponse({ commands: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await daemon;

  assert.equal(registrations[0].supportedAgents.includes("codex"), true);
  assert.equal(registrations[0].supportedAgents.includes("kimi"), false);
  assert.equal(registrations[0].sandboxMode, "boxlite");
  assert.equal(registrations[0].workspaceId, "repo:relay");
  assert.equal(registrations[0].agentHealth?.kimi?.status, "failed");
  assert.match(registrations[0].agentHealth?.kimi?.detail ?? "", /not logged in/);
});

test("local node refreshes agent availability before heartbeat registration", async () => {
  const stop = new AbortController();
  const registrations: DaemonNodeRegistration[] = [];
  let codexChecks = 0;
  await runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_local_refresh",
    employeeId: "alice",
    workspacePath: process.cwd(),
    sandbox: "none",
    token: "node_token",
    pollIntervalMs: 1,
    heartbeatIntervalMs: 1,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      ensure: async (agent) => {
        if (agent === "codex" && codexChecks++ === 0) {
          throw new Error("Codex is not logged in.");
        }
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") {
        registrations.push(await jsonBody<DaemonNodeRegistration>(init));
        if (registrations.length === 2) stop.abort();
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/commands")) return jsonResponse({ commands: [] });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(registrations[0].supportedAgents.includes("codex"), false);
  assert.equal(registrations[1].supportedAgents.includes("codex"), true);
});

test("capability refresh never probes agents while a run is active", async () => {
  const stop = new AbortController();
  const command = runCommand("cmd_active_refresh");
  let served = false;
  let polls = 0;
  let readinessChecks = 0;
  let checksWhenRunStarted = 0;
  let checksBeforeRelease = 0;
  let released = false;
  let releaseRun!: () => void;
  const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
  await runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_active_refresh",
    employeeId: "alice",
    workspacePath: process.cwd(),
    sandbox: "none",
    token: "node_token",
    pollIntervalMs: 1,
    heartbeatIntervalMs: 1,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      ensure: async () => { readinessChecks += 1; },
      exec: async (_cmd, args, options) => {
        if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
        checksWhenRunStarted = readinessChecks;
        await runGate;
        options?.stdoutRenderer?.("done\n");
        return { exit_code: 0, stdout: "done\n", stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!served) {
          served = true;
          return jsonResponse({ commands: [command] });
        }
        polls += 1;
        // Wait until execution has entered the held-open run. Capability
        // refreshes before the command is fetched are valid; only probes after
        // this point would contend with the active local agent process.
        if (!released && polls >= 10 && checksWhenRunStarted > 0) {
          released = true;
          checksBeforeRelease = readinessChecks;
          releaseRun();
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        if (event.type === "run.completed" || event.type === "run.failed") setTimeout(() => stop.abort(), 0);
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(checksBeforeRelease, checksWhenRunStarted);
});

test("daemon renews liveness while an idle command poll is in flight", async () => {
  const stop = new AbortController();
  let commandPolls = 0;
  let heartbeats = 0;
  await runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_explicit_heartbeat",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    commandPollWaitMs: 25_000,
    livenessHeartbeatIntervalMs: 2,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment(),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") {
        return jsonResponse({ heartbeat: { intervalMs: 5_000, timeoutMs: 15_000 } });
      }
      if (path.endsWith("/heartbeat")) {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer node_token");
        const body = await jsonBody<{ activeCommandLeases: unknown[] }>(init);
        assert.deepEqual(body.activeCommandLeases, []);
        heartbeats += 1;
        stop.abort();
        return jsonResponse({
          heartbeat: {
            intervalMs: 5_000,
            timeoutMs: 15_000,
            observedAt: new Date().toISOString(),
          },
        });
      }
      if (path.endsWith("/commands")) {
        commandPolls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return jsonResponse({ commands: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(commandPolls, 1);
  assert.equal(heartbeats, 1);
});

test("relay daemon doctor reports per-agent preflight failures", async () => {
  const report = await runRelayDaemonDoctor({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    logger: testLogger(),
    environment: fakeEnvironment({
      ensure: async (agent) => {
        if (agent === "codex") throw new Error("Codex auth missing.");
      },
    }),
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(report.ok, false);
  const codex = report.checks.find((check) => check.name === "agent:codex");
  assert.equal(codex?.ok, false);
  assert.match(codex?.detail ?? "", /auth missing/);
});

test("relay daemon retries terminal event posts across backend failures", async () => {
  const stop = new AbortController();
  let terminalAttempts = 0;
  const command = runCommand("cmd_retry");
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment(),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) return jsonResponse({ commands: terminalAttempts === 0 ? [command] : [] });
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        if (event.type === "run.completed") {
          terminalAttempts += 1;
          if (terminalAttempts === 1) return jsonResponse({ error: "temporary" }, 500);
          stop.abort();
        }
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await daemon;

  assert.equal(terminalAttempts, 2);
});

test("relay daemon preserves final agent log and generated files when output event post fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-output-post-failed-"));
  const stop = new AbortController();
  const command = {
    ...runCommand("cmd_output_post_failed"),
    workspacePath: root,
  };
  const events: DaemonNodeEvent[] = [];
  let commandServed = false;
  let controlPath = "";
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: root,
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (!isInventoryProbe(args)) {
          const cwd = options?.cwd ?? root;
          mkdirSync(join(cwd, ".relay"), { recursive: true });
          controlPath = join(cwd, ROUND_RESULT_RELATIVE_PATH);
          writeFileSync(controlPath, JSON.stringify({ status: "done", runId: command.runId }));
          writeFileSync(join(options?.cwd ?? root, "agent-loop-guide.md"), "# Agent Loop\n");
          options?.stdoutRenderer?.("  done\n\n");
        }
        return { exit_code: 0, stdout: "  done\n\n", stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [command] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        events.push(event);
        if (event.type === "run.output.batch") return jsonResponse({ error: "bad output event" }, 400);
        if (event.type === "run.failed" || event.type === "run.completed") setTimeout(() => stop.abort(), 0);
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await Promise.race([
    daemon,
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not post terminal event")), 1000)),
  ]);

  const failed = events.find((event) => event.type === "run.failed");
  assert.equal(failed?.type, "run.failed");
  if (!failed || failed.type !== "run.failed") throw new Error("missing run.failed event");
  assert.equal(failed.agentLog, "[Codex Exit 0]\nstdout:\n  done\n\n");
  assert.match(failed.error, /Daemon lost agent output/);
  assert.deepEqual(failed.generatedFiles?.map((file) => file.relativePath), ["agent-loop-guide.md"]);
  assert.equal(existsSync(controlPath), false);
});

test("relay daemon batches large alternating output without losing order", async () => {
  const stop = new AbortController();
  const command = runCommand("cmd_output_backlog");
  const rawChunks = Array.from(
    { length: 300 },
    (_, index) => `${String(index).padStart(3, "0")}:${"x".repeat(32_760)}\n`,
  );
  let commandServed = false;
  let terminalType = "";
  let registration: DaemonNodeRegistration | undefined;
  const outputBatches: Array<{
    type: "run.output.batch";
    entries: Array<{ stream: "stdout" | "stderr"; text: string; sequence: number }>;
  }> = [];
  await runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    sandbox: "none",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 1,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (!isInventoryProbe(args)) {
          for (let index = 0; index < rawChunks.length; index += 1) {
            const render = index % 2 === 0
              ? options?.stdoutRenderer
              : options?.stderrRenderer;
            render?.(rawChunks[index]);
          }
        }
        return { exit_code: 0, stdout: "done", stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") {
        registration = await jsonBody<DaemonNodeRegistration>(init);
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [command] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent | typeof outputBatches[number]>(init);
        if (event.type === "run.output.batch") outputBatches.push(event);
        if (event.type === "run.failed" || event.type === "run.completed") {
          terminalType = event.type;
          setTimeout(() => stop.abort(), 0);
        }
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(terminalType, "run.completed");
  assert.equal(registration?.protocolVersion, 2);
  assert.ok(outputBatches.length < 64, `expected bounded HTTP batches, received ${outputBatches.length}`);
  const entries = outputBatches.flatMap((event) => event.entries);
  assert.equal(entries.map((entry) => entry.text).join(""), rawChunks.join(""));
  assert.equal(
    entries.filter((entry) => entry.stream === "stdout").map((entry) => entry.text).join(""),
    rawChunks.filter((_, index) => index % 2 === 0).join(""),
  );
  assert.equal(
    entries.filter((entry) => entry.stream === "stderr").map((entry) => entry.text).join(""),
    rawChunks.filter((_, index) => index % 2 === 1).join(""),
  );
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    Array.from({ length: entries.length }, (_, index) => index),
  );
  assert.match(entries[0]?.text ?? "", /^000:/);
  assert.match(entries.at(-1)?.text ?? "", /^299:/);
});

test("relay daemon fails safely when undelivered output exceeds its memory budget", async () => {
  const previousLimit = process.env.RELAY_DAEMON_OUTPUT_BACKLOG_BYTES;
  process.env.RELAY_DAEMON_OUTPUT_BACKLOG_BYTES = "1024";
  const stop = new AbortController();
  const command = runCommand("cmd_output_budget");
  let served = false;
  let terminalType = "";
  try {
    await runRelayDaemon({
      backendUrl: "http://relay.test",
      sandboxId: "sbx_output_budget",
      sandbox: "none",
      employeeId: "alice",
      workspacePath: process.cwd(),
      token: "node_token",
      pollIntervalMs: 1,
      shutdownGraceMs: 50,
      logger: testLogger(),
      signal: stop.signal,
      environment: fakeEnvironment({
        exec: async (_cmd, args, options) => {
          if (!isInventoryProbe(args)) options?.stdoutRenderer?.("x".repeat(2048));
          return { exit_code: 0, stdout: "done", stderr: "" };
        },
      }),
      fetchFn: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/api") return jsonResponse({ name: "Relay backend" });
        if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
        if (path.endsWith("/commands")) {
          if (!served) {
            served = true;
            return jsonResponse({ commands: [command] });
          }
          return jsonResponse({ commands: [] });
        }
        if (path.endsWith("/events")) {
          const event = await jsonBody<DaemonNodeEvent>(init);
          if (event.type === "run.completed" || event.type === "run.failed") {
            terminalType = event.type;
            setTimeout(() => stop.abort(), 0);
          }
          return jsonResponse({ ok: true }, 202);
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });
  } finally {
    restoreEnv("RELAY_DAEMON_OUTPUT_BACKLOG_BYTES", previousLimit);
  }

  assert.equal(terminalType, "run.failed");
});

test("daemon logger flushes non-blocking node and run logs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-daemon-logger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logDir = join(root, "private-daemon-state", "logs");
  const logger = createDaemonLogger({ workspacePath: root, sandboxId: "sbx_test", logDir });

  logger.output({ runId: "run_test", stream: "stdout", text: "hello", sequence: 0 });
  assert.equal(typeof logger.flush, "function");
  await logger.flush?.();

  assert.match(readFileSync(join(logDir, "sbx_test.jsonl"), "utf8"), /"text":"hello"/);
  assert.match(readFileSync(join(logDir, "run_test.jsonl"), "utf8"), /"text":"hello"/);
  assert.equal(existsSync(join(root, ".relay")), false);
});

test("relay daemon exits startup preflight after external stop", async () => {
  const stop = new AbortController();
  let closeCount = 0;
  let preflightAborted = false;
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: {
      ...fakeEnvironment(),
      close: async () => {
        closeCount += 1;
      },
    },
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") {
        const signal = init?.signal as AbortSignal | undefined;
        setTimeout(() => stop.abort(), 0);
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            preflightAborted = true;
            reject(new Error("preflight aborted"));
          }, { once: true });
        });
      }
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await Promise.race([
    daemon,
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not stop")), 500)),
  ]);

  assert.equal(preflightAborted, true);
  assert.equal(closeCount, 1);
});

test("relay daemon skips startup probes when external stop is already requested", async () => {
  const stop = new AbortController();
  stop.abort();
  let closeCount = 0;
  let ensureCount = 0;
  let inventoryCount = 0;
  await runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: {
      ...fakeEnvironment({
        ensure: async () => {
          ensureCount += 1;
        },
        exec: async () => {
          inventoryCount += 1;
          return { exit_code: 0, stdout: "", stderr: "" };
        },
      }),
      close: async () => {
        closeCount += 1;
      },
    },
    fetchFn: async (url) => {
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(ensureCount, 0);
  assert.equal(inventoryCount, 0);
  assert.equal(closeCount, 1);
});

test("relay daemon exits backend reconnect after external stop during registration", async () => {
  const stop = new AbortController();
  let registerAttempts = 0;
  let closeCount = 0;
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    preflight: false,
    environment: {
      ...fakeEnvironment(),
      close: async () => {
        closeCount += 1;
      },
    },
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/daemon-node-registrations") {
        registerAttempts += 1;
        stop.abort();
        return new Response("backend unavailable", { status: 503 });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await Promise.race([
    daemon,
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not stop")), 500)),
  ]);

  assert.ok(registerAttempts >= 1);
  assert.equal(closeCount, 1);
});

test("managed daemon retries transient enrollment failures before registration", async () => {
  const stop = new AbortController();
  let enrollmentAttempts = 0;
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    enrollmentToken: "grant.secret",
    workspacePath: process.cwd(),
    pollIntervalMs: 1,
    shutdownGraceMs: 20,
    logger: testLogger(),
    signal: stop.signal,
    preflight: false,
    environment: fakeEnvironment(),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/daemon-node-enrollments") {
        enrollmentAttempts += 1;
        if (enrollmentAttempts === 1) return new Response("backend unavailable", { status: 503 });
        return jsonResponse({
          sandboxId: "sbx_managed",
          token: "node_token",
          employeeId: "alice",
          sandboxMode: "boxlite",
          heartbeat: { intervalMs: 5, timeoutMs: 15 },
        }, 201);
      }
      if (path === "/api/v1/daemon-node-registrations") {
        if (JSON.parse(String(init?.body)).status === "stopped") return jsonResponse({ ok: true });
        return jsonResponse({ heartbeat: { intervalMs: 5, timeoutMs: 15 } });
      }
      if (path === "/api/v1/daemon-nodes/sbx_managed/commands") {
        stop.abort();
        return jsonResponse({ commands: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await Promise.race([
    daemon,
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not stop")), 4_000)),
  ]);

  assert.equal(enrollmentAttempts, 2);
});

test("relay daemon removes shutdown listeners after external stop", async () => {
  const stop = new AbortController();
  const beforeSigint = process.listenerCount("SIGINT");
  const beforeSigterm = process.listenerCount("SIGTERM");
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment(),
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        stop.abort();
        return jsonResponse({ commands: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await daemon;

  assert.equal(process.listenerCount("SIGINT"), beforeSigint);
  assert.equal(process.listenerCount("SIGTERM"), beforeSigterm);
});

test("relay daemon exits polling sleep after external stop", async () => {
  const stop = new AbortController();
  let closeCount = 0;
  let commandPolls = 0;
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 10_000,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: {
      ...fakeEnvironment(),
      close: async () => {
        closeCount += 1;
      },
    },
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        commandPolls += 1;
        stop.abort();
        return jsonResponse({ commands: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await Promise.race([
    daemon,
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not stop")), 500)),
  ]);

  assert.equal(commandPolls, 1);
  assert.equal(closeCount, 1);
});

test("relay daemon immediately renews a completed long poll by default", async () => {
  const stop = new AbortController();
  let commandPolls = 0;
  const timeout = setTimeout(() => stop.abort(), 250);
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    commandPollWaitMs: 20,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    preflight: false,
    environment: fakeEnvironment(),
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        commandPolls += 1;
        if (commandPolls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (commandPolls === 2) stop.abort();
        return jsonResponse({ commands: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  try {
    await daemon;
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(commandPolls, 2);
});

test("relay daemon retains the default delay after a rejected command poll", async () => {
  const stop = new AbortController();
  let commandPolls = 0;
  const timeout = setTimeout(() => stop.abort(), 100);
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    preflight: false,
    environment: fakeEnvironment(),
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        commandPolls += 1;
        if (commandPolls === 2) stop.abort();
        return new Response("rejected", { status: 401 });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  try {
    await daemon;
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(commandPolls, 1);
});

test("relay daemon retains the default delay when long polling is disabled", async () => {
  const stop = new AbortController();
  let commandPolls = 0;
  const timeout = setTimeout(() => stop.abort(), 100);
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    commandPollWaitMs: 0,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    preflight: false,
    environment: fakeEnvironment(),
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        commandPolls += 1;
        if (commandPolls === 2) stop.abort();
        return jsonResponse({ commands: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  try {
    await daemon;
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(commandPolls, 1);
});

test("relay daemon retains the default delay when an empty long poll returns early", async () => {
  const stop = new AbortController();
  let commandPolls = 0;
  const timeout = setTimeout(() => stop.abort(), 100);
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    commandPollWaitMs: 25_000,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    preflight: false,
    environment: fakeEnvironment(),
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        commandPolls += 1;
        if (commandPolls === 2) stop.abort();
        return jsonResponse({ commands: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  try {
    await daemon;
  } finally {
    clearTimeout(timeout);
  }

  assert.equal(commandPolls, 1);
});

test("relay daemon bounds stopped registration during shutdown", async () => {
  const stop = new AbortController();
  let closeCount = 0;
  let stoppedRegisterAborted = false;
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: {
      ...fakeEnvironment(),
      close: async () => {
        closeCount += 1;
      },
    },
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") {
        const registration = await jsonBody<DaemonNodeRegistration>(init);
        if (registration.status !== "stopped") return jsonResponse({ ok: true });
        const signal = init?.signal as AbortSignal | undefined;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            stoppedRegisterAborted = true;
            reject(new Error("stopped registration aborted"));
          }, { once: true });
        });
      }
      if (path.endsWith("/commands")) {
        stop.abort();
        return jsonResponse({ commands: [] });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await Promise.race([
    daemon,
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not stop")), 1_500)),
  ]);

  assert.equal(stoppedRegisterAborted, true);
  assert.equal(closeCount, 1);
});

test("relay daemon posts cancellation during shutdown", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-cancel-checkpoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let controlPath = "";
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let commandServed = false;
  const command = { ...runCommand("cmd_shutdown"), workspacePath: root };
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: root,
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 200,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
        const cwd = options?.cwd ?? root;
        mkdirSync(join(cwd, ".relay"), { recursive: true });
        controlPath = join(cwd, ROUND_RESULT_RELATIVE_PATH);
        writeFileSync(controlPath, JSON.stringify({ status: "done", runId: command.runId }));
        stop.abort();
        while (!options?.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return { exit_code: 143, stdout: "partial migration work", stderr: "", error_message: "cancelled" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [command] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        events.push(await jsonBody<DaemonNodeEvent>(init));
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await daemon;

  assert.equal(events.some((event) => event.type === "run.cancelled"), true);
  assert.match(JSON.stringify(events.find((event) => event.type === "run.cancelled")), /partial migration work/);
  assert.equal(existsSync(controlPath), false);
});

test("relay daemon bounds cancellation event retry during shutdown", async () => {
  const stop = new AbortController();
  let closeCount = 0;
  let commandServed = false;
  let cancellationAttempts = 0;
  const command = runCommand("cmd_cancel_retry");
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 1_000,
    logger: testLogger(),
    signal: stop.signal,
    environment: {
      ...fakeEnvironment({
        exec: async (_cmd, args, options) => {
          if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
          stop.abort();
          while (!options?.signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          return { exit_code: 143, stdout: "", stderr: "", error_message: "cancelled" };
        },
      }),
      close: async () => {
        closeCount += 1;
      },
    },
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [command] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        if (event.type === "run.cancelled") {
          cancellationAttempts += 1;
          return jsonResponse({ error: "temporary" }, 500);
        }
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await Promise.race([
    daemon,
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not stop")), 1_500)),
  ]);

  assert.ok(cancellationAttempts >= 1);
  assert.equal(closeCount, 1);
});

test("relay daemon retries normal run.cancel terminal event while running", async () => {
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let commandServed = false;
  let cancelServed = false;
  let cancellationAttempts = 0;
  const command = runCommand("cmd_user_cancel");
  const cancelCommand = {
    id: "cmd_user_cancel_request",
    type: "run.cancel",
    commandId: command.id,
    sessionId: command.sessionId,
    runId: command.runId,
    agent: command.agent,
    reason: "Cancelled from UI.",
  } satisfies DaemonNodeCommand;
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 200,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
        while (!options?.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        return { exit_code: 130, stdout: "", stderr: "", error_message: "cancelled" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [command] });
        }
        if (!cancelServed) {
          cancelServed = true;
          return jsonResponse({ commands: [cancelCommand] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        events.push(event);
        if (event.type === "run.cancelled") {
          cancellationAttempts += 1;
          if (cancellationAttempts === 1) return jsonResponse({ error: "temporary" }, 500);
          stop.abort();
        }
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await Promise.race([
    daemon,
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not stop")), 2_500)),
  ]);

  assert.equal(cancellationAttempts, 2);
  assert.deepEqual(events.flatMap((event) => event.type === "run.cancelled" ? [event.reason] : []), [
    "Cancelled from UI.",
    "Cancelled from UI.",
  ]);
});

test("relay daemon rejects a second distinct run while busy", async () => {
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let commandServed = false;
  const first = runCommand("cmd_busy_1");
  const second = { ...runCommand("cmd_busy_2"), runId: "run_2", sessionId: "ses_2" } satisfies DaemonNodeCommand;
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 100,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
        while (!events.some((event) => event.type === "run.failed" && event.commandId === "cmd_busy_2")) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        options?.sink?.("done\n");
        return { exit_code: 0, stdout: "done\n", stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [first, second] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        events.push(event);
        if (event.type === "run.completed" && event.commandId === "cmd_busy_1") stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await daemon;

  assert.equal(events.some((event) => event.type === "run.failed" && event.commandId === "cmd_busy_2"), true);
  assert.equal(events.some((event) => event.type === "run.completed" && event.commandId === "cmd_busy_1"), true);
});

test("relay daemon runs concurrent commands within capacity", async () => {
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  const started = new Set<string>();
  let commandServed = false;
  const first = runCommand("cmd_1");
  const second = { ...runCommand("cmd_2"), runId: "run_2", sessionId: "ses_2" };
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 100,
    maxConcurrentRuns: 2,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
        const runId = started.size === 0 ? "run_1" : "run_2";
        started.add(runId);
        while (started.size < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        options?.sink?.(`${runId} done\n`);
        return { exit_code: 0, stdout: `${runId} done\n`, stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [first, second] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        events.push(event);
        if (events.filter((item) => item.type === "run.completed").length === 2) stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await daemon;

  assert.deepEqual(
    events.filter((event) => event.type === "run.completed").map((event) => event.commandId).sort(),
    ["cmd_1", "cmd_2"],
  );
  assert.equal(events.some((event) => event.type === "run.failed"), false);
});

test("relay daemon stops while retrying a busy-command rejection event", async () => {
  const stop = new AbortController();
  let closeCount = 0;
  let commandServed = false;
  let busyRejectAttempts = 0;
  const first = runCommand("cmd_busy_stop_1");
  const second = { ...runCommand("cmd_busy_stop_2"), runId: "run_2", sessionId: "ses_2" } satisfies DaemonNodeCommand;
  const daemon = runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: {
      ...fakeEnvironment({
        exec: async (_cmd, args, options) => {
          if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
          while (!options?.signal?.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          return { exit_code: 143, stdout: "", stderr: "", error_message: "cancelled" };
        },
      }),
      close: async () => {
        closeCount += 1;
      },
    },
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [first, second] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        if (event.type === "run.failed" && event.commandId === "cmd_busy_stop_2") {
          busyRejectAttempts += 1;
          stop.abort();
          return jsonResponse({ error: "temporary" }, 500);
        }
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await Promise.race([
    daemon,
    new Promise((_, reject) => setTimeout(() => reject(new Error("daemon did not stop")), 500)),
  ]);

  assert.equal(busyRejectAttempts, 1);
  assert.equal(closeCount, 1);
});

test("relay daemon can register, poll, execute, and report through a local backend server", async (t) => {
  const stop = new AbortController();
  const command = runCommand("cmd_http");
  let commandServed = false;
  const events: DaemonNodeEvent[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/") {
      sendJson(res, 200, { name: "Relay backend" });
      return;
    }
    if (req.url === "/api/v1/daemon-node-registrations" && req.method === "POST") {
      sendJson(res, 200, { ok: true });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/v1/daemon-nodes/sbx_http/commands" && req.method === "GET") {
      sendJson(res, 200, { commands: commandServed ? [] : [command] });
      commandServed = true;
      return;
    }
    if (req.url === "/api/v1/daemon-nodes/sbx_http/events" && req.method === "POST") {
      const event = JSON.parse(await readRequest(req)) as DaemonNodeEvent;
      events.push(event);
      if (event.type === "run.completed") stop.abort();
      sendJson(res, 202, { ok: true });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
  if (!await listenOrSkip(server, t)) return;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test server address.");
  const port = (address as AddressInfo).port;

  try {
    await runRelayDaemon({
      backendUrl: `http://127.0.0.1:${port}`,
      sandboxId: "sbx_http",
      employeeId: "alice",
      workspacePath: process.cwd(),
      token: "node_token",
      pollIntervalMs: 5,
      shutdownGraceMs: 100,
      logger: testLogger(),
      signal: stop.signal,
      environment: fakeEnvironment(),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  assert.equal(events.some((event) => event.type === "run.output.batch"), true);
  assert.equal(events.some((event) => event.type === "run.completed"), true);
});

async function jsonBody<T>(init: RequestInit | undefined): Promise<T> {
  if (typeof init?.body !== "string") throw new Error("Expected JSON request body.");
  return JSON.parse(init.body) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readRequest(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listenOrSkip(server: ReturnType<typeof createServer>, t: TestContext): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip(`local listen blocked by environment: ${error.code}`);
        resolve(false);
        return;
      }
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function inventoryLine(kind: "SKILL" | "MCP", agent: string, id: string, content: string): string {
  return [kind, agent, id, Buffer.from(content, "utf8").toString("base64")].join("\t");
}

test("parseInventoryOutput reads skill frontmatter and MCP servers per agent", () => {
  const skillMd = "---\nname: brainstorming\ndescription: Structured brainstorming.\n---\nbody";
  const mcpJson = JSON.stringify({
    mcpServers: {
      codegraph: { command: "codegraph", args: ["serve"] },
      remote: { url: "https://user:pass@example.com/sse?token=secret#fragment", type: "sse" },
    },
  });
  const stdout = [
    inventoryLine("SKILL", "claude", "superpowers/brainstorming/SKILL.md", skillMd),
    inventoryLine("SKILL", "claude", "frontend-design/SKILL.md", "---\nname: frontend-design\n---\n"),
    inventoryLine("MCP", "claude", ".claude.json", mcpJson),
    inventoryLine(
      "MCP",
      "codex",
      ".codex/config.toml",
      '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n\n[mcp_servers.remote]\nurl = "https://example.com/mcp?token=secret"\n',
    ),
    inventoryLine("SKILL", "bogus-agent", "x/SKILL.md", skillMd),
    "",
  ].join("\n");

  const inventory = parseInventoryOutput(stdout);
  const claude = inventory.claude;
  assert.ok(claude, "claude inventory present");
  assert.deepEqual(
    claude.skills.map((s) => ({ name: s.name, namespace: s.namespace, description: s.description })),
    [
      { name: "brainstorming", namespace: "superpowers", description: "Structured brainstorming." },
      { name: "frontend-design", namespace: undefined, description: undefined },
    ],
  );
  assert.deepEqual(
    claude.mcpServers.map((m) => ({ name: m.name, transport: m.transport })),
    [
      { name: "codegraph", transport: "stdio" },
      { name: "remote", transport: "sse" },
    ],
  );
  assert.equal(claude.mcpServers.find((server) => server.name === "remote")?.command, "https://example.com/sse");
  assert.deepEqual(
    inventory.codex?.mcpServers.map((server) => ({ name: server.name, transport: server.transport, command: server.command })),
    [
      { name: "context7", transport: "stdio", command: "npx" },
      { name: "remote", transport: "http", command: "https://example.com/mcp" },
    ],
  );
  assert.equal(inventory["bogus-agent" as "claude"], undefined);
});

test("agent skills are provisioned and inventoried for every supported CLI", () => {
  const boxSource = readFileSync(join(process.cwd(), "packages/relay-daemon/src/box.ts"), "utf8");
  for (const directory of [".claude/skills", ".codex/skills", ".pi/skills", ".kimi/skills"]) {
    assert.match(boxSource, new RegExp(directory.replace(".", "\\.")));
  }
  const daemonSource = readFileSync(join(process.cwd(), "packages/relay-daemon/src/index.ts"), "utf8");
  assert.match(daemonSource, /ensureLocalAgentReady[\s\S]*prepareHostAgentSkills/);
});

test("devbox pins every installed agent CLI to an exact version", () => {
  const source = readFileSync(join(process.cwd(), "dockerfile"), "utf8");
  for (const packageName of [
    "@anthropic-ai/claude-code",
    "@openai/codex",
    "@earendil-works/pi-coding-agent",
    "@moonshot-ai/kimi-code",
  ]) {
    assert.match(source, new RegExp(`${packageName.replace("/", "\\/")}@[0-9]+\\.[0-9]+\\.[0-9]+`));
  }
});

test("discoverAgentInventory returns empty on non-zero exit and never throws", async () => {
  const failing = async (): Promise<StreamExecResult> => ({ exit_code: 1, stdout: "ignored", stderr: "" });
  assert.deepEqual(await discoverAgentInventory(failing), {});
  const throwing = async (): Promise<StreamExecResult> => {
    throw new Error("exec exploded");
  };
  assert.deepEqual(await discoverAgentInventory(throwing), {});
});

test("discoverAgentInventory aborts a hung inventory probe at its deadline", async () => {
  let aborted = false;
  const hanging: DaemonExecutionEnvironment["execStream"] = async (_cmd, _args, options) =>
    await new Promise<StreamExecResult>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    });

  assert.deepEqual(await discoverAgentInventory(hanging, undefined, 5), {});
  assert.equal(aborted, true);
});

test("backend reconnect delay uses capped equal jitter", () => {
  assert.equal(backendReconnectDelayMs(1, () => 0), 1000);
  assert.equal(backendReconnectDelayMs(1, () => 1), 2000);
  assert.equal(backendReconnectDelayMs(4, () => 0), 5000);
  assert.equal(backendReconnectDelayMs(20, () => 1), 10000);
});

test("relay daemon reports generated workspace documents in run.completed", async (t: TestContext) => {
  const { mkdtempSync, mkdirSync: makeDir, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-daemon-generated-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  const registrations: DaemonNodeRegistration[] = [];
  let commandServed = false;
  const base = runCommand();
  assert.ok(base.type === "run.start");
  const command: DaemonNodeCommand = {
    ...base,
    workspacePath: workspace,
    logicalAgentId: "agent_research",
  };
  const threadWorkspace = joinPath(workspace, command.sessionId);
  await runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: workspace,
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (!isInventoryProbe(args)) {
          assert.equal(options?.cwd, threadWorkspace);
          writeFile(joinPath(threadWorkspace, agentWorkspaceSubpath("agent_research"), "quarterly-report.pdf"), "pdf bytes");
          writeFile(joinPath(threadWorkspace, agentWorkspaceSubpath("agent_research"), "server.key"), "not a document");
          writeFile(joinPath(threadWorkspace, "shared-summary.csv"), "a,b\n");
          makeDir(joinPath(threadWorkspace, agentWorkspaceSubpath("agent_other")), { recursive: true });
          writeFile(joinPath(threadWorkspace, agentWorkspaceSubpath("agent_other"), "private.pdf"), "sibling private");
        }
        const rendered = options?.stdoutRenderer?.("done\n") ?? "done\n";
        options?.sink?.(rendered);
        return { exit_code: 0, stdout: "done\n", stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") {
        registrations.push(await jsonBody<DaemonNodeRegistration>(init));
        return jsonResponse({ ok: true });
      }
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [command] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        events.push(await jsonBody<DaemonNodeEvent>(init));
        if (events.some((event) => event.type === "run.completed")) stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(registrations[0]?.capabilities?.includes("generated-files"), true);
  assert.equal(registrations[0]?.capabilities?.includes("thread-workspaces"), true);
  const completed = events.find((event) => event.type === "run.completed");
  assert.ok(completed && completed.type === "run.completed");
  const reported = (completed.generatedFiles ?? []).map((item) => item.relativePath).sort();
  // Shared-root files and the agent's own home are reported; a sibling
  // agent's private home is never attributed to this run.
  assert.deepEqual(reported, [
    "agents/agent-YWdlbnRfcmVzZWFyY2g/quarterly-report.pdf",
    "shared-summary.csv",
  ]);
  const file = (completed.generatedFiles ?? []).find((item) => item.relativePath.endsWith(".pdf"));
  assert.ok(file);
  assert.equal(file.contentType, "application/pdf");
  assert.equal(Buffer.from(file.contentBase64 ?? "", "base64").toString("utf-8"), "pdf bytes");
});

test("upgraded daemon keeps legacy sessions on the existing node root", async (t: TestContext) => {
  const workspace = mkdtempSync(join(tmpdir(), "relay-daemon-legacy-workspace-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "existing-checkout.txt"), "preserve me");

  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let commandServed = false;
  const command: DaemonNodeRunCommand = {
    ...runCommand("cmd_legacy"),
    workspacePath: workspace,
  };
  delete command.workspaceLayout;

  await runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_test",
    employeeId: "alice",
    workspacePath: workspace,
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 50,
    logger: testLogger(),
    signal: stop.signal,
    environment: fakeEnvironment({
      exec: async (_cmd, args, options) => {
        if (!isInventoryProbe(args)) {
          assert.equal(options?.cwd, workspace);
          assert.equal(readFileSync(join(workspace, "existing-checkout.txt"), "utf8"), "preserve me");
        }
        return { exit_code: 0, stdout: "done\n", stderr: "" };
      },
    }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!commandServed) {
          commandServed = true;
          return jsonResponse({ commands: [command] });
        }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        const event = await jsonBody<DaemonNodeEvent>(init);
        events.push(event);
        if (event.type === "run.completed") stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(events.some((event) => event.type === "run.completed"), true);
  assert.equal(existsSync(join(workspace, command.sessionId)), false);
});

test("generated-file diff detects changed files and skips excluded directories", async (t: TestContext) => {
  const { mkdtempSync, mkdirSync: makeDir, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { snapshotGeneratedFiles, diffGeneratedFiles } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-diff-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFile(joinPath(workspace, "data.csv"), "a,b\n");
  makeDir(joinPath(workspace, "node_modules"));
  writeFile(joinPath(workspace, "node_modules", "vendored.pdf"), "ignored");
  const before = snapshotGeneratedFiles(workspace);

  makeDir(joinPath(workspace, "output"));
  writeFile(joinPath(workspace, "report.html"), "<h1>hi</h1>");
  writeFile(joinPath(workspace, "data.csv"), "a,b\nc,d\n");
  writeFile(joinPath(workspace, "output", "summary.md"), "# Summary\n");
  // A doc written beside the work is the agent's deliverable; one buried in a
  // checkout the run merely touched is not.
  writeFile(joinPath(workspace, "notes.md"), "a thread-root deliverable\n");
  makeDir(joinPath(workspace, "checkout"));
  writeFile(joinPath(workspace, "checkout", "README.md"), "someone else's repo\n");

  const changed = diffGeneratedFiles(workspace, before);
  assert.deepEqual(changed.map((file) => file.relativePath).sort(), [
    "data.csv",
    "notes.md",
    "output/summary.md",
    "report.html",
  ]);
  assert.deepEqual(diffGeneratedFiles(workspace, snapshotGeneratedFiles(workspace)), []);
});

test("generated-file scan never uploads likely credentials or opaque archives", async (t: TestContext) => {
  const { mkdtempSync, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { diffGeneratedFiles } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-secrets-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  writeFile(joinPath(workspace, "credentials.json"), '{"token":"tok_super_secret"}');
  writeFile(joinPath(workspace, "report.txt"), "OPENAI_API_KEY=sk-secret-value");
  writeFile(joinPath(workspace, "bundle.zip"), "opaque archive");
  writeFile(joinPath(workspace, "safe-report.txt"), "No secrets here.\n");

  const changed = diffGeneratedFiles(workspace, {});
  assert.deepEqual(changed.map((file) => file.relativePath), ["safe-report.txt"]);
});

test("generated-file scan reports text documents at an agent home root and output dir", async (t: TestContext) => {
  const { mkdtempSync, mkdirSync: makeDir, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { diffGeneratedFiles } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-textdocs-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const own = agentWorkspaceSubpath("agent_self");
  makeDir(joinPath(workspace, own, "output"), { recursive: true });
  makeDir(joinPath(workspace, own, "scratch"), { recursive: true });
  writeFile(joinPath(workspace, own, "guide.md"), "# Guide\n");
  writeFile(joinPath(workspace, own, "output", "report.txt"), "done\n");
  writeFile(joinPath(workspace, own, "scratch", "buffer.md"), "working notes\n");

  const changed = diffGeneratedFiles(workspace, {}, { ownAgentHomeSubdir: own });
  assert.deepEqual(changed.map((file) => file.relativePath).sort(), [
    `${own}/guide.md`,
    `${own}/output/report.txt`,
  ]);
});

test("generated-file scan skips sibling agent homes but keeps the running agent's own", async (t: TestContext) => {
  const { mkdtempSync, mkdirSync: makeDir, rmSync, writeFileSync: writeFile } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { diffGeneratedFiles } = await import("../src/generated-files.js");
  const workspace = mkdtempSync(joinPath(tmpdir(), "relay-generated-homes-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const own = agentWorkspaceSubpath("agent_self");
  const sibling = agentWorkspaceSubpath("agent_other");
  makeDir(joinPath(workspace, own), { recursive: true });
  makeDir(joinPath(workspace, sibling, "nested"), { recursive: true });
  writeFile(joinPath(workspace, "shared.csv"), "a,b\n");
  writeFile(joinPath(workspace, own, "mine.pdf"), "mine");
  writeFile(joinPath(workspace, sibling, "theirs.pdf"), "theirs");
  writeFile(joinPath(workspace, sibling, "nested", "deep.pdf"), "deep");

  const changed = diffGeneratedFiles(workspace, {}, { ownAgentHomeSubdir: own });
  assert.deepEqual(
    changed.map((file) => file.relativePath).sort(),
    [`${own}/mine.pdf`, "shared.csv"],
  );

  const unscoped = diffGeneratedFiles(workspace, {});
  assert.equal(unscoped.length, 4);
});

test("listWorkspace lists files relative to the provided root and sorts directories first", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-ws-"));
  try {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "report.md"), "hello");
    writeFileSync(join(root, "outside.txt"), "secret");

    const listing = listWorkspace(root, "");
    assert.equal(listing.exists, true);
    assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.kind]), [["sub", "directory"], ["outside.txt", "file"], ["report.md", "file"]]);
    assert.deepEqual(listWorkspace(root, "sub"), { path: "sub", exists: true, entries: [] });
    assert.deepEqual(listWorkspace(root, "missing"), { path: "missing", exists: false, entries: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readWorkspaceFile rejects escapes and caps text while identifying binary data", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-ws-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "relay-ws-out-"));
  try {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "small.txt"), "hello");
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, "big.txt"), "x".repeat(64));
    writeFileSync(join(outsideRoot, "outside.txt"), "secret");
    symlinkSync(outsideRoot, join(root, "escape"));

    assert.throws(() => readWorkspaceFile(root, "../outside.txt"), (error: unknown) => error instanceof WorkspaceReadError && error.code === "invalid-path");
    assert.throws(() => readWorkspaceFile(root, "/outside.txt"), (error: unknown) => error instanceof WorkspaceReadError && error.code === "invalid-path");
    assert.throws(() => readWorkspaceFile(root, "escape/outside.txt"), (error: unknown) => error instanceof WorkspaceReadError && error.code === "invalid-path");
    assert.throws(() => readWorkspaceFile(root, "sub"), (error: unknown) => error instanceof WorkspaceReadError && error.code === "is-directory");
    assert.throws(() => readWorkspaceFile(root, "missing.txt"), (error: unknown) => error instanceof WorkspaceReadError && error.code === "not-found");
    assert.equal(Buffer.from(readWorkspaceFile(root, "small.txt").contentBase64 ?? "", "base64").toString(), "hello");
    assert.equal(readWorkspaceFile(root, "bin.dat").isBinary, true);
    // Binary bytes still ship (capped) so image/PDF previews can render.
    assert.equal(readWorkspaceFile(root, "bin.dat").contentBase64, Buffer.from([0, 1, 2]).toString("base64"));
    const capped = readWorkspaceFile(root, "big.txt", 16);
    assert.equal(capped.truncated, true);
    assert.equal(Buffer.from(capped.contentBase64 ?? "", "base64").byteLength, 16);
    assert.equal(capped.bytes, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("readWorkspaceFile decodes UTF-16 and tolerates codepoints split by the read limit", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-ws-"));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "utf16le.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")]));
    writeFileSync(join(root, "utf16be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("héllo", "utf16le").swap16()]));
    writeFileSync(join(root, "emoji.txt"), "ab🙂cd");
    writeFileSync(join(root, "invalid.txt"), Buffer.from([0x61, 0xc0, 0xaf, 0x62]));

    const le = readWorkspaceFile(root, "utf16le.txt");
    assert.equal(le.isBinary, false);
    assert.equal(Buffer.from(le.contentBase64 ?? "", "base64").toString("utf-8"), "héllo");
    const be = readWorkspaceFile(root, "utf16be.txt");
    assert.equal(be.isBinary, false);
    assert.equal(Buffer.from(be.contentBase64 ?? "", "base64").toString("utf-8"), "héllo");

    // "ab🙂" is 6 bytes (🙂 = 4); a 5-byte limit splits the codepoint — still text.
    const split = readWorkspaceFile(root, "emoji.txt", 5);
    assert.equal(split.isBinary, false);
    assert.equal(split.truncated, true);
    assert.equal(Buffer.from(split.contentBase64 ?? "", "base64").toString("utf-8"), "ab");
    const whole = readWorkspaceFile(root, "emoji.txt");
    assert.equal(Buffer.from(whole.contentBase64 ?? "", "base64").toString("utf-8"), "ab🙂cd");

    // Genuinely invalid UTF-8 (overlong sequence) stays binary.
    assert.equal(readWorkspaceFile(root, "invalid.txt").isBinary, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace reads expose the provided root but never escape it", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-ws-shared-"));
  try {
    const home = join(root, agentWorkspaceSubpath("agent_1"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, "shared.md"), "team notes");
    writeFileSync(join(home, "private.md"), "mine");

    const listing = listWorkspace(root, "");
    assert.equal(listing.exists, true);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["agents", "shared.md"]);
    const file = readWorkspaceFile(root, "shared.md");
    assert.equal(Buffer.from(file.contentBase64 ?? "", "base64").toString(), "team notes");
    // Agent homes are reachable through the shared root if a caller walks there.
    const nested = readWorkspaceFile(root, `agents/${agentWorkspaceSubpath("agent_1").split("/").pop()}/private.md`);
    assert.equal(Buffer.from(nested.contentBase64 ?? "", "base64").toString(), "mine");
    assert.throws(() => readWorkspaceFile(root, "../escape.md"), (error: unknown) => error instanceof WorkspaceReadError && error.code === "invalid-path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay daemon serves project workspace commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-ws-"));
  const projectId = "prj_workspace_read";
  const workspaceSubpath = "projects/prj_workspace_read";
  const projectRoot = join(root, workspaceSubpath);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "report.md"), "hello");
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let registration: DaemonNodeRegistration | undefined;
  let served = false;
  await runRelayDaemon({
    backendUrl: "http://relay.test", sandboxId: "sbx_test", employeeId: "alice", workspacePath: root, token: "node_token",
    pollIntervalMs: 5, shutdownGraceMs: 50, logger: testLogger(), signal: stop.signal,
    environment: fakeEnvironment({ exec: async () => ({ exit_code: 0, stdout: "", stderr: "" }) }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") { registration = await jsonBody<DaemonNodeRegistration>(init); return jsonResponse({ ok: true }); }
      if (path.endsWith("/commands")) {
        if (!served) { served = true; return jsonResponse({ commands: [
          { id: "cmd_ls", type: "workspace.list", sessionId: projectId, workspaceLayout: "project", workspaceSubpath, path: "" },
          { id: "cmd_read", type: "workspace.read", sessionId: projectId, workspaceLayout: "project", workspaceSubpath, path: "report.md" },
          { id: "cmd_bad", type: "workspace.read", sessionId: projectId, workspaceLayout: "project", workspaceSubpath, path: "../escape" },
        ] }); }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        events.push(await jsonBody<DaemonNodeEvent>(init));
        if (events.length === 3) stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  rmSync(root, { recursive: true, force: true });

  assert.equal(registration?.capabilities?.includes("workspace-read-shared"), true);
  const listing = events.find((event) => event.type === "workspace.listing");
  assert.ok(listing && listing.type === "workspace.listing");
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["report.md"]);
  const file = events.find((event) => event.type === "workspace.file");
  assert.ok(file && file.type === "workspace.file");
  assert.equal(Buffer.from(file.contentBase64 ?? "", "base64").toString(), "hello");
  const error = events.find((event) => event.type === "workspace.error");
  assert.ok(error && error.type === "workspace.error");
  assert.equal(error.code, "invalid-path");
});

test("relay daemon resolves a task workspace under the node root", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-ws-"));
  const taskId = "tsk_workspace_read";
  const workspaceSubpath = "tasks/tsk_one";
  const taskRoot = join(root, workspaceSubpath);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(join(taskRoot, "report.md"), "hello");
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let registration: DaemonNodeRegistration | undefined;
  let served = false;
  await runRelayDaemon({
    backendUrl: "http://relay.test", sandboxId: "sbx_test", employeeId: "alice", workspacePath: root, token: "node_token",
    pollIntervalMs: 5, shutdownGraceMs: 50, logger: testLogger(), signal: stop.signal,
    environment: fakeEnvironment({ exec: async () => ({ exit_code: 0, stdout: "", stderr: "" }) }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") { registration = await jsonBody<DaemonNodeRegistration>(init); return jsonResponse({ ok: true }); }
      if (path.endsWith("/commands")) {
        if (!served) { served = true; return jsonResponse({ commands: [
          { id: "cmd_ls", type: "workspace.list", sessionId: taskId, workspaceLayout: "task", workspaceSubpath, path: "" },
        ] }); }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        events.push(await jsonBody<DaemonNodeEvent>(init));
        if (events.length === 1) stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  rmSync(root, { recursive: true, force: true });

  assert.equal(registration?.capabilities?.includes("task-workspaces"), true);
  const listing = events.find((event) => event.type === "workspace.listing");
  assert.ok(listing && listing.type === "workspace.listing");
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["report.md"]);
});

test("relay daemon rejects a task workspace path that escapes the node root", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-ws-"));
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let served = false;
  await runRelayDaemon({
    backendUrl: "http://relay.test", sandboxId: "sbx_test", employeeId: "alice", workspacePath: root, token: "node_token",
    pollIntervalMs: 5, shutdownGraceMs: 50, logger: testLogger(), signal: stop.signal,
    environment: fakeEnvironment({ exec: async () => ({ exit_code: 0, stdout: "", stderr: "" }) }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!served) { served = true; return jsonResponse({ commands: [
          { id: "cmd_bad", type: "workspace.read", sessionId: "ses_one", workspaceLayout: "task", workspaceSubpath: "tasks/../../escape", path: "report.md" },
        ] }); }
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        events.push(await jsonBody<DaemonNodeEvent>(init));
        if (events.length === 1) stop.abort();
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  rmSync(root, { recursive: true, force: true });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "workspace.error");
  assert.equal((events[0] as { code?: string }).code, "invalid-path");
});

test("relay daemon fails a run.start command with an escaping workspaceSubpath instead of crashing", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-ws-"));
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let served = false;
  const badCommand: DaemonNodeRunCommand = {
    ...runCommand("cmd_bad_run"),
    workspacePath: root,
    workspaceLayout: "task",
    workspaceSubpath: "tasks/../../escape",
  };
  await runRelayDaemon({
    backendUrl: "http://relay.test", sandboxId: "sbx_test", employeeId: "alice", workspacePath: root, token: "node_token",
    pollIntervalMs: 5, shutdownGraceMs: 50, logger: testLogger(), signal: stop.signal,
    environment: fakeEnvironment({ exec: async () => ({ exit_code: 0, stdout: "", stderr: "" }) }),
    fetchFn: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
      if (path.endsWith("/commands")) {
        if (!served) { served = true; return jsonResponse({ commands: [badCommand] }); }
        // Polling keeps working after the bad command is rejected — the daemon
        // process must not have crashed out of runRelayDaemon.
        stop.abort();
        return jsonResponse({ commands: [] });
      }
      if (path.endsWith("/events")) {
        events.push(await jsonBody<DaemonNodeEvent>(init));
        return jsonResponse({ ok: true }, 202);
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  rmSync(root, { recursive: true, force: true });

  const failed = events.find((event) => event.type === "run.failed");
  assert.ok(failed && failed.type === "run.failed", "expected a run.failed event for the bad workspaceSubpath");
  assert.equal(failed.commandId, "cmd_bad_run");
});

for (const workspaceLayout of ["task", "node-root"] as const) {
  test(`relay daemon serializes two runs that share one ${workspaceLayout} workspace`, async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-ws-"));
    const stop = new AbortController();
    const events: DaemonNodeEvent[] = [];
    const order: string[] = [];
    let commandServed = false;
    const commandA: DaemonNodeRunCommand = {
      ...runCommand("cmd_a"),
      sessionId: "ses_a",
      runId: "run_a",
      taskGoal: "shared-task-goal-a",
      workspacePath: root,
      workspaceLayout,
      workspaceSubpath: "tasks/tsk_one",
    };
    const commandB: DaemonNodeRunCommand = {
      ...runCommand("cmd_b"),
      sessionId: "ses_b",
      runId: "run_b",
      taskGoal: "shared-task-goal-b",
      workspacePath: root,
      workspaceLayout,
      workspaceSubpath: "tasks/tsk_one",
    };
    await runRelayDaemon({
      backendUrl: "http://relay.test",
      sandboxId: "sbx_test",
      employeeId: "alice",
      workspacePath: root,
      token: "node_token",
      pollIntervalMs: 5,
      shutdownGraceMs: 100,
      maxConcurrentRuns: 2,
      logger: testLogger(),
      signal: stop.signal,
      environment: fakeEnvironment({
        exec: async (_cmd, args) => {
          if (isInventoryProbe(args)) return { exit_code: 0, stdout: "", stderr: "" };
          const runId = args?.[1]?.includes("shared-task-goal-a") ? "run_a" : "run_b";
          order.push(runId);
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push(`${runId}:done`);
          return { exit_code: 0, stdout: "done\n", stderr: "" };
        },
      }),
      fetchFn: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/api") return jsonResponse({ name: "Relay backend" });
        if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
        if (path.endsWith("/commands")) {
          if (!commandServed) {
            commandServed = true;
            return jsonResponse({ commands: [commandA, commandB] });
          }
          return jsonResponse({ commands: [] });
        }
        if (path.endsWith("/events")) {
          const event = await jsonBody<DaemonNodeEvent>(init);
          events.push(event);
          if (events.filter((item) => item.type === "run.completed").length === 2) stop.abort();
          return jsonResponse({ ok: true }, 202);
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });
    rmSync(root, { recursive: true, force: true });

    // Two run.start commands that share one task directory must not execute
    // concurrently: they share a directory, so an unserialized pair lets a
    // reviewer overwrite an implementer's files mid-run.
    assert.deepEqual(order, ["run_a", "run_a:done", "run_b", "run_b:done"]);
    assert.equal(events.some((event) => event.type === "run.failed"), false);
  });
}

test("daemon stops instead of retrying when the backend reports the node was deleted", async () => {
  const registrations: string[] = [];
  await runRelayDaemon({
    backendUrl: "http://relay.test",
    sandboxId: "sbx_deleted",
    employeeId: "alice",
    workspacePath: process.cwd(),
    token: "node_token",
    pollIntervalMs: 5,
    shutdownGraceMs: 10,
    logger: testLogger(),
    environment: fakeEnvironment(),
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api") return jsonResponse({ name: "Relay backend" });
      if (path === "/api/v1/daemon-node-registrations") {
        registrations.push(path);
        return jsonResponse({ detail: "Daemon node sbx_deleted was deleted in the control panel." }, 410);
      }
      return jsonResponse({ commands: [] });
    },
  });

  // One rejected attempt, and no "stopped" registration afterwards: the node
  // is gone, so there is nothing left to report to.
  assert.equal(registrations.length, 1);
});

test("daemon cannot inherit a stale verdict from the shared workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "relay-stale-verdict-"));
  const controlPath = join(workspace, ROUND_RESULT_RELATIVE_PATH);
  mkdirSync(join(workspace, ".relay"));
  writeFileSync(controlPath, JSON.stringify({ status: "done" }));
  const stop = new AbortController();
  const events: DaemonNodeEvent[] = [];
  let served = false;
  try {
    await runRelayDaemon({
      backendUrl: "http://relay.test", sandboxId: "sbx_test", employeeId: "alice",
      workspacePath: workspace, token: "node_token", pollIntervalMs: 5,
      signal: stop.signal, logger: testLogger(), environment: fakeEnvironment(),
      fetchFn: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/api") return jsonResponse({ name: "Relay backend" });
        if (path === "/api/v1/daemon-node-registrations") return jsonResponse({ ok: true });
        if (path.endsWith("/commands")) {
          if (served) return jsonResponse({ commands: [] });
          served = true;
          return jsonResponse({ commands: [{ ...runCommand(), workspacePath: workspace, workspaceLayout: "node-root" }] });
        }
        if (path.endsWith("/events")) {
          const event = await jsonBody<DaemonNodeEvent>(init);
          events.push(event);
          if (event.type === "run.completed" || event.type === "run.failed") stop.abort();
          return jsonResponse({ ok: true }, 202);
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });
    const completed = events.find((event) => event.type === "run.completed");
    assert.ok(completed?.type === "run.completed");
    assert.equal(completed.roundResult, undefined);
    assert.equal(existsSync(controlPath), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("consumes the round result a run leaves behind and refuses malformed ones", () => {
  const workspace = mkdtempSync(join(tmpdir(), "relay-round-result-"));
  const controlPath = join(workspace, ROUND_RESULT_RELATIVE_PATH);
  mkdirSync(join(workspace, ".relay"), { recursive: true });

  // Nothing written: the run simply said nothing about being finished.
  assert.equal(consumeRoundResult(workspace), undefined);

  writeFileSync(controlPath, JSON.stringify({ status: "continue", note: "  schema left  " }));
  assert.deepEqual(consumeRoundResult(workspace), { status: "continue", note: "schema left" });
  // Consumed: a later round must not inherit this verdict and report "done"
  // because a previous round said so.
  assert.equal(existsSync(controlPath), false);

  for (const runId of [undefined, "old-run", "current-run"]) {
    writeFileSync(controlPath, JSON.stringify({ status: "done", runId }));
    assert.deepEqual(consumeRoundResult(workspace, "current-run"),
      runId === "current-run" ? { status: "done" } : undefined);
    assert.equal(existsSync(controlPath), false);
  }

  for (const malformed of ['{"status":"whatever"}', "not json at all", '["done"]', '{"note":"no status"}']) {
    writeFileSync(controlPath, malformed);
    assert.equal(consumeRoundResult(workspace), undefined, malformed);
    assert.equal(existsSync(controlPath), false, `${malformed} should still be consumed`);
  }

  rmSync(workspace, { recursive: true, force: true });
});
