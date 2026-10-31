import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { answerPermissionRequest, questionKind, RunJsonWriter, runOpenCodeAcp, SessionUpdateTranslator, type AskBroker } from "../src/permission-adapters/opencode-acp.js";
import { permissionAdapterScript } from "../src/permission-adapters/index.js";
import type { PermissionQuestion } from "../src/permission-adapters/protocol.js";

// A stand-in for `opencode acp`: answers the handshake, streams one turn with
// a shell call that asks for approval, and logs the client's answer and model
// pin to $FAKE_OPENCODE_LOG. FAKE_OPENCODE_HANG=1 never finishes the prompt.
const FAKE_OPENCODE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const log = (entry) => appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify(entry) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const update = (sessionId, payload) => send({ method: "session/update", params: { sessionId, update: payload } });
let promptId;
let sessionId = "ses_fake";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    // The client's answer to our session/request_permission.
    log({ answer: message.result });
    const allowed = message.result?.outcome?.optionId === "once";
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: allowed ? "completed" : "failed", rawOutput: allowed ? "hi" : "denied" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "Done." : "Blocked." } });
    send({ id: promptId, result: { stopReason: "end_turn" } });
    return;
  }
  switch (message.method) {
    case "initialize": return send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "OpenCode", version: "2.2.0" } } });
    case "session/new": return send({ id: message.id, result: { sessionId } });
    case "session/set_config_option": log({ model: message.params.value }); return send({ id: message.id, result: { configOptions: [] } });
    case "session/prompt":
      promptId = message.id;
      if (process.env.FAKE_OPENCODE_HANG) return;
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working." } });
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", name: "shell", title: "echo hi", kind: "execute", status: "pending", rawInput: { command: "echo hi" } });
      send({ id: 100, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "call_1", name: "shell", title: "echo hi", kind: "execute", status: "pending", rawInput: { command: "echo hi" } }, options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ] } });
      return;
    default: return send({ id: message.id, error: { code: -32601, message: "nope" } });
  }
});
`;

const root = mkdtempSync(join(tmpdir(), "relay-opencode-acp-"));
const fakeOpenCode = join(root, "opencode");
writeFileSync(fakeOpenCode, FAKE_OPENCODE);
chmodSync(fakeOpenCode, 0o755);
after(() => rmSync(root, { recursive: true, force: true }));

let runCount = 0;

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  questions: PermissionQuestion[];
  log: Array<Record<string, unknown>>;
}

async function run(
  behavior: "allow" | "deny",
  { model, signal, hang }: { model?: string; signal?: AbortSignal; hang?: boolean } = {},
): Promise<Captured> {
  const logPath = join(root, `log-${++runCount}.jsonl`);
  let stdout = "";
  let stderr = "";
  const questions: PermissionQuestion[] = [];
  const ask: AskBroker = async (question) => {
    questions.push(question);
    return behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "no" };
  };
  const code = await runOpenCodeAcp(
    { opencodeCommand: fakeOpenCode, cwd: root, prompt: "do the thing", ...(model ? { model } : {}) },
    {
      stdout: { write: (text: string) => { stdout += text; } },
      stderr: { write: (text: string) => { stderr += text; } },
      ask,
      signal,
      env: { ...process.env, FAKE_OPENCODE_LOG: logPath, ...(hang ? { FAKE_OPENCODE_HANG: "1" } : {}) },
    },
  );
  const log = readFileLines(logPath);
  return { code, stdout, stderr, questions, log };
}

function readFileLines(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function events(stdout: string): Array<Record<string, unknown>> {
  return stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("OpenCode ACP adapter", () => {
  it("answers an approved tool with allow_once and prints run-format events", async () => {
    const result = await run("allow");

    assert.equal(result.code, 0);
    assert.equal(result.questions.length, 1);
    assert.deepEqual(result.questions[0], {
      kind: "command",
      toolName: "shell",
      input: { command: "echo hi" },
      toolUseId: "call_1",
      reason: "echo hi",
    });
    assert.deepEqual(result.log[0], { answer: { outcome: { outcome: "selected", optionId: "once" } } });
    const lines = events(result.stdout);
    assert.deepEqual(lines[0], { type: "text", part: { type: "text", text: "Working." } });
    assert.equal((lines[1].part as { tool: string }).tool, "shell");
    assert.equal((lines[1].part as { state: { status: string } }).state.status, "completed");
    assert.deepEqual(lines[2], { type: "text", part: { type: "text", text: "Done." } });
  });

  it("denies with reject and never selects the always option", async () => {
    const result = await run("deny");

    assert.equal(result.code, 0);
    assert.deepEqual(result.log[0], { answer: { outcome: { outcome: "selected", optionId: "reject" } } });
    assert.notEqual((result.log[0].answer as { outcome: { optionId: string } }).outcome.optionId, "always");
    const failed = events(result.stdout).find((line) => line.type === "tool_use");
    const state = (failed?.part as { state: { status: string; error?: string; output?: string } }).state;
    assert.equal(state.status, "error");
    assert.equal(state.error, "denied");
    assert.equal(state.output, undefined);
  });

  it("selects the pinned model before the prompt", async () => {
    const result = await run("allow", { model: "deepseek/deepseek-flash" });

    assert.deepEqual(result.log.find((entry) => "model" in entry), { model: "deepseek/deepseek-flash" });
  });

  it("stops the child and reports 130 when the run is cancelled mid-prompt", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300).unref();
    const result = await run("allow", { signal: controller.signal, hang: true });

    assert.equal(result.code, 130);
  });
});

describe("OpenCode ACP adapter helpers", () => {
  it("maps ACP tool kinds onto the broker's question kinds", () => {
    assert.equal(questionKind("execute"), "command");
    assert.equal(questionKind("edit"), "file_change");
    assert.equal(questionKind("delete"), "file_change");
    assert.equal(questionKind("read"), "tool");
    assert.equal(questionKind(undefined), "tool");
  });

  it("cancels the request when the agent offers no one-shot option of the wanted kind", async () => {
    const translator = new SessionUpdateTranslator(new RunJsonWriter({ write: () => true }));
    const ask: AskBroker = async () => ({ behavior: "allow" });
    const outcome = await answerPermissionRequest({ options: [{ optionId: "always", kind: "allow_always" }], toolCall: {} }, translator, ask);

    assert.deepEqual(outcome, { outcome: { outcome: "cancelled" } });
  });

  it("denies when the broker cannot be asked", async () => {
    const translator = new SessionUpdateTranslator(new RunJsonWriter({ write: () => true }));
    const ask: AskBroker = async () => { throw new Error("broker down"); };
    const outcome = await answerPermissionRequest({
      options: [{ optionId: "once", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }],
      toolCall: { toolCallId: "t", name: "shell" },
    }, translator, ask);

    assert.deepEqual(outcome, { outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("is compiled as a launchable adapter script", () => {
    assert.equal(permissionAdapterScript("opencode-acp"), fileURLToPath(new URL("../src/permission-adapters/opencode-acp.js", import.meta.url)));
  });
});
