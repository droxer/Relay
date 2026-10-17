import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { runKimiAcp, type AskBroker } from "../src/permission-adapters/kimi-acp.js";
import { permissionAdapterScript } from "../src/permission-adapters/index.js";
import type { PermissionQuestion } from "../src/permission-adapters/protocol.js";

// A stand-in for `kimi acp`: answers the handshake, streams one turn with a
// Bash call that needs approval, asks one AskUserQuestion, and logs what the
// client chose to $FAKE_KIMI_LOG. FAKE_KIMI_HANG=1 never finishes the prompt.
const FAKE_KIMI = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const log = (entry) => appendFileSync(process.env.FAKE_KIMI_LOG, JSON.stringify(entry) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
const waiting = new Map();
const ask = (id, params) => new Promise((resolve) => { waiting.set(id, resolve); send({ id, method: "session/request_permission", params }); });
const options = [
  { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
  { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];
log({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
process.on("SIGTERM", () => { log({ signal: "SIGTERM" }); process.exit(143); });
async function prompt(id, params) {
  const sid = params.sessionId;
  log({ prompt: params.prompt });
  if (process.env.FAKE_KIMI_HANG === "1") { log({ hanging: true }); return; }
  update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me " } });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "check." } });
  const call = "turn_1:Bash:0";
  update(sid, { sessionUpdate: "tool_call", toolCallId: call, title: "Bash", kind: "execute", status: "pending", content: [{ type: "content", content: { type: "text", text: "{\\"command\\":" } }] });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: call, title: "Run touch", kind: "execute", status: "in_progress", rawInput: { command: "touch x" } });
  const decision = await ask("perm-1", { sessionId: sid, options, toolCall: { toolCallId: call, title: "Bash", content: [{ type: "content", content: { type: "text", text: "Requesting approval to run touch x" } }] } });
  log({ decision });
  const allowed = decision.outcome.optionId === "approve_once";
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: call, status: allowed ? "completed" : "failed", rawOutput: allowed ? "ok" : { error: "rejected" } });
  const question = await ask("perm-2", { sessionId: sid, options: [{ optionId: "q0_opt_0", name: "A", kind: "allow_once" }, { optionId: "q0_skip", name: "Skip", kind: "reject_once" }], toolCall: { toolCallId: "turn_1:ask", title: "AskUserQuestion" } });
  log({ question });
  update(sid, { sessionUpdate: "plan", entries: [] });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  update(sid, { sessionUpdate: "usage_update", used: 10, size: 100 });
  send({ id, result: { stopReason: process.env.FAKE_KIMI_STOP || "end_turn" } });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) { const resolve = waiting.get(message.id); waiting.delete(message.id); resolve?.(message.result); return; }
  log({ method: message.method, params: message.params });
  switch (message.method) {
    case "initialize": return send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "9.9.9" } } });
    case "session/new": return send({ id: message.id, result: { sessionId: "session_fake" } });
    case "session/set_mode": return send({ id: message.id, result: {} });
    case "session/set_config_option":
      if (message.params.value === "missing") return send({ id: message.id, error: { code: -32602, message: "unknown model" } });
      return send({ id: message.id, result: { configOptions: [] } });
    case "session/prompt": return void prompt(message.id, message.params);
    default: return send({ id: message.id, error: { code: -32601, message: "nope" } });
  }
});
`;

const root = mkdtempSync(join(tmpdir(), "relay-kimi-acp-"));
const fakeKimi = join(root, "kimi");
writeFileSync(fakeKimi, FAKE_KIMI);
chmodSync(fakeKimi, 0o755);
after(() => rmSync(root, { recursive: true, force: true }));

let runCount = 0;
function newLog(): string {
  return join(root, `log-${++runCount}.jsonl`);
}

function readLog(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  questions: PermissionQuestion[];
  log: Array<Record<string, unknown>>;
}

async function run(
  answer: "allow" | "deny",
  { env = {}, model, signal }: { env?: Record<string, string>; model?: string; signal?: AbortSignal } = {},
): Promise<Captured> {
  const logPath = newLog();
  let stdout = "";
  let stderr = "";
  const questions: PermissionQuestion[] = [];
  const ask: AskBroker = async (question) => {
    questions.push(question);
    return answer === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "no" };
  };
  const code = await runKimiAcp(
    { kimiCommand: fakeKimi, cwd: root, prompt: "do the thing", ...(model ? { model } : {}) },
    {
      stdout: { write: (text: string) => { stdout += text; } },
      stderr: { write: (text: string) => { stderr += text; } },
      ask,
      signal,
      env: { ...process.env, FAKE_KIMI_LOG: logPath, ...env },
    },
  );
  return { code, stdout, stderr, questions, log: readLog(logPath) };
}

function lines(stdout: string): Array<Record<string, unknown>> {
  return stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Kimi ACP adapter", () => {
  it("prints `kimi -p` stream-json lines for the turn", async () => {
    const result = await run("allow");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(lines(result.stdout), [
      { role: "meta", type: "system.version", version: "9.9.9" },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ type: "function", id: "turn_1:Bash:0", function: { name: "Bash", arguments: "{\"command\":\"touch x\"}" } }],
      },
      { role: "tool", tool_call_id: "turn_1:Bash:0", content: "ok" },
      { role: "assistant", content: "Done." },
      { role: "meta", type: "session.resume_hint", session_id: "session_fake", command: "kimi -r session_fake" },
    ]);
  });

  it("starts the session in Ask When Needed mode in the workspace, then prompts", async () => {
    const result = await run("allow", { model: "kimi-code/k3" });
    const methods = result.log.flatMap((entry) => typeof entry.method === "string" ? [entry] : []);
    assert.deepEqual(methods.map((entry) => entry.method), [
      "initialize", "session/new", "session/set_mode", "session/set_config_option", "session/prompt",
    ]);
    assert.deepEqual(methods[0].params, {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    assert.deepEqual(methods[1].params, { cwd: root, mcpServers: [] });
    assert.deepEqual(methods[2].params, { sessionId: "session_fake", modeId: "yolo" });
    assert.deepEqual(methods[3].params, { sessionId: "session_fake", configId: "model", value: "kimi-code/k3" });
    assert.deepEqual(methods[4].params, { sessionId: "session_fake", prompt: [{ type: "text", text: "do the thing" }] });
    assert.deepEqual(result.log[0].argv, ["acp"]);
  });

  it("asks the broker once per approval and answers allow with allow_once", async () => {
    const result = await run("allow");
    assert.deepEqual(result.questions, [{
      kind: "command",
      toolName: "Bash",
      input: { command: "touch x" },
      toolUseId: "turn_1:Bash:0",
      reason: "Requesting approval to run touch x",
    }]);
    const decision = result.log.find((entry) => "decision" in entry)?.decision;
    assert.deepEqual(decision, { outcome: { outcome: "selected", optionId: "approve_once" } });
  });

  it("answers deny with reject_once and still finishes the turn", async () => {
    const result = await run("deny");
    assert.equal(result.code, 0, result.stderr);
    const decision = result.log.find((entry) => "decision" in entry)?.decision;
    assert.deepEqual(decision, { outcome: { outcome: "selected", optionId: "reject" } });
    const tool = lines(result.stdout).find((line) => line.role === "tool");
    assert.equal(tool?.content, "{\"error\":\"rejected\"}");
  });

  it("skips an AskUserQuestion without asking the broker", async () => {
    const result = await run("allow");
    assert.equal(result.questions.length, 1);
    const question = result.log.find((entry) => "question" in entry)?.question;
    assert.deepEqual(question, { outcome: { outcome: "selected", optionId: "q0_skip" } });
  });

  it("fails the run when Kimi stops the turn for anything but end_turn", async () => {
    const result = await run("allow", { env: { FAKE_KIMI_STOP: "refusal" } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Kimi stopped the turn \(refusal\)/);
    assert.doesNotMatch(result.stdout, /resume_hint/);
  });

  it("fails the run when Kimi rejects a request", async () => {
    const result = await run("allow", { model: "missing" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /error: failed to run prompt: unknown model/);
  });

  it("fails when the kimi executable cannot start", async () => {
    let stderr = "";
    const code = await runKimiAcp(
      { kimiCommand: join(root, "no-such-kimi"), cwd: root, prompt: "x" },
      { stdout: { write: () => {} }, stderr: { write: (text: string) => { stderr += text; } }, ask: async () => ({ behavior: "deny" }) },
    );
    assert.equal(code, 1);
    assert.match(stderr, /could not start/);
  });

  it("stops kimi promptly when the run is aborted", async () => {
    const abort = new AbortController();
    const logPath = newLog();
    const started = Date.now();
    const pending = runKimiAcp(
      { kimiCommand: fakeKimi, cwd: root, prompt: "hang" },
      {
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        ask: async () => ({ behavior: "deny" }),
        signal: abort.signal,
        env: { ...process.env, FAKE_KIMI_LOG: logPath, FAKE_KIMI_HANG: "1" },
      },
    );
    await waitFor(() => {
      try { return readLog(logPath).some((entry) => entry.hanging === true); } catch { return false; }
    });
    abort.abort("cancelled");
    assert.equal(await pending, 130);
    assert.ok(Date.now() - started < 5_000);
    assert.ok(readLog(logPath).some((entry) => entry.signal === "SIGTERM"));
  });

  it("runs as a script and reaches a broker over the permission socket", async () => {
    const script = permissionAdapterScript("kimi-acp");
    assert.equal(script, fileURLToPath(new URL("../src/permission-adapters/kimi-acp.js", import.meta.url)));
    const received: Array<Record<string, unknown>> = [];
    const socketPath = join(root, "broker.sock");
    const broker = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received.push(JSON.parse(chunk.trim()) as Record<string, unknown>);
        socket.end(`${JSON.stringify({ behavior: "deny", message: "Denied by the user in Relay." })}\n`);
      });
    });
    await new Promise<void>((resolve) => broker.listen(socketPath, resolve));
    try {
      const logPath = newLog();
      const child = spawn(process.execPath, [script, "--kimi", fakeKimi, "--cwd", root, "--prompt", "hi"], {
        env: { ...process.env, FAKE_KIMI_LOG: logPath, RELAY_PERMISSION_SOCKET: socketPath, RELAY_PERMISSION_SECRET: "s3cret" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      assert.equal(code, 0);
      assert.equal(received.length, 1);
      assert.equal(received[0].secret, "s3cret");
      assert.equal(received[0].toolName, "Bash");
      assert.equal(received[0].kind, "command");
      assert.deepEqual(readLog(logPath).find((entry) => "decision" in entry)?.decision, { outcome: { outcome: "selected", optionId: "reject" } });
      assert.match(stdout, /"type":"session.resume_hint"/);
    } finally {
      broker.close();
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
