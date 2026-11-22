import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { DaemonNodeEvent, DaemonNodeSteerCommand, LiveMessageDelivery } from "relay-core";

import { startPermissionBroker, type PermissionBrokerOptions } from "../src/permission-broker.js";
import { LiveRuns } from "../src/live-runs.js";
import { brokerAddress, listenForLiveMessages, type LiveMessageHandler, type LiveMessageListener } from "../src/permission-adapters/protocol.js";
import { runCodexTurn } from "../src/permission-adapters/codex-app-server.js";
import { runOpenCodeAcp } from "../src/permission-adapters/opencode-acp.js";
import { parseClaudeStreamArgs, runClaudeStream, userMessage } from "../src/permission-adapters/claude-stream.js";
import { createLiveMessageHandler } from "../src/permission-adapters/pi-extension.js";

const scratch = mkdtempSync(join(tmpdir(), "relay-live-messages-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function script(name: string, source: string): string {
  const path = join(scratch, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function logLines(path: string): Array<Record<string, any>> {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
  } catch {
    return [];
  }
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** An adapter's `listen`, captured so a test can play the broker's part. */
function capturedListener() {
  const state: { handler?: LiveMessageHandler; closed: boolean } = { closed: false };
  const listen = (handler: LiveMessageHandler): LiveMessageListener => {
    state.handler = handler;
    return { close: () => { state.closed = true; } };
  };
  return { state, listen };
}

function brokerOptions(): PermissionBrokerOptions {
  return {
    fetchFn: (async () => new Response("{}", { status: 404 })) as typeof fetch,
    backendUrl: "http://backend.test",
    sandboxId: "sandbox-1",
    token: "node-token",
    command: { id: "cmd-1", sessionId: "session-1", runId: "run-1", agent: "codex", leaseId: "lease-1" },
    postEvent: async (_event: DaemonNodeEvent) => {},
  };
}

describe("live message channel", () => {
  it("carries a message from the daemon to the listening adapter and back, once per id", async () => {
    const broker = await startPermissionBroker(brokerOptions());
    const received: string[] = [];
    const listener = listenForLiveMessages(async (message) => {
      received.push(message.text);
      return "steer";
    }, broker.env);
    try {
      assert.ok(listener);
      await waitFor(() => broker.liveMessages.listening, "the adapter to listen");
      assert.deepEqual(await broker.liveMessages.deliver("msg-1", "Use the staging database."), { outcome: "delivered", delivery: "steer" });
      // A redelivered command gets the first answer without a second copy.
      assert.deepEqual(await broker.liveMessages.deliver("msg-1", "Use the staging database."), { outcome: "delivered", delivery: "steer" });
      assert.deepEqual(received, ["Use the staging database."]);
    } finally {
      listener?.close();
      await broker.close();
    }
  });

  it("reports a runtime's refusal as failed with its reason", async () => {
    const broker = await startPermissionBroker(brokerOptions());
    const listener = listenForLiveMessages(async () => { throw new Error("no turn in progress"); }, broker.env);
    try {
      await waitFor(() => broker.liveMessages.listening, "the adapter to listen");
      assert.deepEqual(await broker.liveMessages.deliver("msg-2", "hello"), { outcome: "failed", reason: "no turn in progress" });
    } finally {
      listener?.close();
      await broker.close();
    }
  });

  it("never lets a connection without the run's secret listen", async () => {
    const broker = await startPermissionBroker(brokerOptions());
    try {
      const { socket } = brokerAddress(broker.env)!;
      const reply = await new Promise<string>((resolve, reject) => {
        const client = connect(socket, () => client.write(`${JSON.stringify({ secret: "wrong", kind: "listen" })}\n`));
        let text = "";
        client.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; }).on("close", () => resolve(text)).on("error", reject);
      });
      // Treated as a question from an outsider: denied, and nobody listens.
      assert.equal(JSON.parse(reply).behavior, "deny");
      assert.equal(broker.liveMessages.listening, false);
      assert.equal((await broker.liveMessages.deliver("msg-3", "hello")).outcome, "unavailable");
    } finally {
      await broker.close();
    }
  });

  it("is unavailable once the run's broker has closed", async () => {
    const broker = await startPermissionBroker(brokerOptions());
    const listener = listenForLiveMessages(async () => "steer", broker.env);
    await waitFor(() => broker.liveMessages.listening, "the adapter to listen");
    await broker.close();
    listener?.close();
    assert.equal((await broker.liveMessages.deliver("msg-4", "late")).outcome, "unavailable");
  });

  it("fails a message whose listener goes away before answering", async () => {
    const broker = await startPermissionBroker(brokerOptions());
    try {
      const { socket, secret } = brokerAddress(broker.env)!;
      // A silent listener: it takes the connection and never replies.
      const client = connect(socket, () => client.write(`${JSON.stringify({ secret, kind: "listen" })}\n`));
      await waitFor(() => broker.liveMessages.listening, "the silent listener");
      const delivery = broker.liveMessages.deliver("msg-5", "anyone?");
      const early = await Promise.race([delivery, new Promise((resolve) => setTimeout(() => resolve("pending"), 50))]);
      assert.equal(early, "pending");
      client.destroy();
      assert.equal((await delivery).outcome, "failed");
    } finally {
      await broker.close();
    }
  });
});

describe("live runs", () => {
  const steer = (overrides: Partial<DaemonNodeSteerCommand> = {}): DaemonNodeSteerCommand => ({
    id: "steer-1", type: "run.steer", leaseId: "lease-9", commandId: "cmd-1", sessionId: "session-1",
    runId: "run-1", agent: "codex", messageId: "msg-1", text: "Prefer the smaller patch.", ...overrides,
  });

  it("answers unavailable for a run that has no live channel on this computer", async () => {
    const event = await new LiveRuns().steer(steer());
    assert.equal(event.type, "run.steered");
    assert.equal(event.outcome, "unavailable");
    assert.equal(event.commandId, "steer-1");
    assert.equal(event.targetCommandId, "cmd-1");
    assert.equal(event.leaseId, "lease-9");
    assert.equal(event.messageId, "msg-1");
  });

  it("refuses an empty message without reaching the runtime", async () => {
    const event = await new LiveRuns().steer(steer({ text: "   " }));
    assert.equal(event.outcome, "failed");
  });

  it("delivers through the registered channel and forgets it when the run ends", async () => {
    const runs = new LiveRuns();
    const broker = await startPermissionBroker(brokerOptions());
    const listener = listenForLiveMessages(async () => "steer", broker.env);
    const unregister = runs.register("cmd-1", broker.liveMessages);
    try {
      await waitFor(() => broker.liveMessages.listening, "the adapter to listen");
      const event = await runs.steer(steer());
      assert.equal(event.outcome, "delivered");
      assert.equal(event.delivery, "steer");
      unregister();
      assert.equal((await runs.steer(steer({ messageId: "msg-2" }))).outcome, "unavailable");
    } finally {
      listener?.close();
      await broker.close();
    }
  });
});

// A stand-in `codex app-server` whose one turn waits for a steer, then completes.
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(process.env.FAKE_LOG, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thr_1" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_1" } } });
    send({ method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1", status: "inProgress", items: [] } } });
  }
  if (message.method === "turn/steer") {
    if (message.params.expectedTurnId !== "turn_1") return send({ id: message.id, error: { code: -32600, message: "turn mismatch" } });
    send({ id: message.id, result: { turnId: "turn_1" } });
    send({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed", items: [], error: null } } });
  }
});
`;

describe("Codex live messages", () => {
  it("steers the active turn with turn/steer and keeps the run going", async () => {
    const codexBin = script("codex", FAKE_CODEX);
    const log = join(scratch, "codex.jsonl");
    writeFileSync(log, "");
    process.env.FAKE_LOG = log;
    const { state, listen } = capturedListener();
    try {
      const turn = runCodexTurn(
        { config: [], cwd: scratch, prompt: "fix the bug" },
        { codexBin, emit: () => {}, ask: async () => ({ behavior: "deny" }), listen },
      );
      await waitFor(() => logLines(log).some((entry) => entry.method === "turn/start"), "the turn to start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(await state.handler!({ id: "msg-1", text: "Use the staging database." }), "steer");
      assert.equal(await turn, 0);
      const steered = logLines(log).find((entry) => entry.method === "turn/steer");
      assert.deepEqual(steered?.params, {
        threadId: "thr_1",
        expectedTurnId: "turn_1",
        input: [{ type: "text", text: "Use the staging database.", text_elements: [] }],
      });
      assert.equal(state.closed, true);
      // After the turn, a message has nowhere to go.
      await assert.rejects(state.handler!({ id: "msg-2", text: "late" }), /no turn in progress/);
    } finally {
      delete process.env.FAKE_LOG;
    }
  });
});

// A stand-in `opencode acp`: the first prompt runs until cancelled, the next ends its turn.
const FAKE_OPENCODE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let running;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(process.env.FAKE_LOG, JSON.stringify(message) + "\\n");
  switch (message.method) {
    case "initialize": return send({ id: message.id, result: { protocolVersion: 1 } });
    case "session/new": return send({ id: message.id, result: { sessionId: "ses_1" } });
    case "session/cancel": if (running !== undefined) { send({ id: running, result: { stopReason: "cancelled" } }); running = undefined; } return;
    case "session/prompt":
      if (message.params.prompt[0].text === "do the thing") { running = message.id; return; }
      return send({ id: message.id, result: { stopReason: "end_turn" } });
  }
});
`;

describe("OpenCode live messages", () => {
  it("interrupts the turn in flight and continues the same session with the message", async () => {
    const opencode = script("opencode", FAKE_OPENCODE);
    const log = join(scratch, "opencode.jsonl");
    writeFileSync(log, "");
    const { state, listen } = capturedListener();
    const run = runOpenCodeAcp(
      { opencodeCommand: opencode, cwd: scratch, prompt: "do the thing" },
      {
        stdout: { write: () => true },
        stderr: { write: () => true },
        ask: async () => ({ behavior: "deny" }),
        env: { ...process.env, FAKE_LOG: log },
        listen,
      },
    );
    await waitFor(() => logLines(log).some((entry) => entry.method === "session/prompt"), "the first prompt");
    assert.equal(await state.handler!({ id: "msg-1", text: "Stop and write tests first." }), "interrupt");
    assert.equal(await run, 0);
    const sent = logLines(log);
    assert.deepEqual(sent.filter((entry) => entry.method === "session/cancel").map((entry) => entry.params), [{ sessionId: "ses_1" }]);
    const prompts = sent.filter((entry) => entry.method === "session/prompt");
    assert.deepEqual(prompts.map((entry) => [entry.params.sessionId, entry.params.prompt[0].text]), [
      ["ses_1", "do the thing"],
      ["ses_1", "Stop and write tests first."],
    ]);
    assert.equal(state.closed, true);
  });
});

// A stand-in `claude -p --input-format stream-json`: one result per user
// message, a short think between them, and exit once its input closes.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), permissionFile: process.env.RELAY_PERMISSION_FILE ?? null }) + "\\n");
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ user: message.message.content[0].text }) + "\\n");
  queue = queue.then(() => new Promise((resolve) => setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m_" + message.message.content[0].text, content: [{ type: "text", text: "ok" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
    resolve();
  }, 80)));
});
lines.on("close", () => { appendFileSync(process.env.FAKE_LOG, JSON.stringify({ stdin: "closed" }) + "\\n"); queue.then(() => process.exit(0)); });
`;

describe("Claude live messages", () => {
  it("answers a mid-turn message as the next turn and exits once every message has its result", async () => {
    const claude = script("claude", FAKE_CLAUDE);
    const log = join(scratch, "claude.jsonl");
    writeFileSync(log, "");
    const { state, listen } = capturedListener();
    let stdout = "";
    const run = runClaudeStream(
      { initialMessages: [userMessage("first task")], argv: [claude, "-p", "--input-format", "stream-json"] },
      {
        stdout: { write: (chunk: Buffer | string) => { stdout += String(chunk); } },
        env: { ...process.env, FAKE_LOG: log, RELAY_PERMISSION_FILE: "/private/broker.json" },
        listen,
      },
    );
    await waitFor(() => logLines(log).some((entry) => entry.user === "first task"), "the prompt");
    assert.equal(await state.handler!({ id: "msg-1", text: "also update the docs" }), "follow-up");
    assert.equal(await run, 0);
    const entries = logLines(log);
    assert.deepEqual(entries.filter((entry) => entry.user).map((entry) => entry.user), ["first task", "also update the docs"]);
    // The broker's address never reached Claude.
    assert.equal(entries[0]!.permissionFile, null);
    assert.equal(stdout.trim().split("\n").filter((line) => JSON.parse(line).type === "result").length, 2);
    await assert.rejects(state.handler!({ id: "msg-2", text: "too late" }), /finished its turn/);
  });

  it("parses its prompt or a prepared stream-json input file", () => {
    assert.deepEqual(parseClaudeStreamArgs(["--prompt", "hi", "--", "claude", "-p"]), {
      initialMessages: [userMessage("hi")],
      argv: ["claude", "-p"],
    });
    const prepared = parseClaudeStreamArgs(["--input-file", "/tmp/m.json", "--", "claude"], () => '{"type":"user"}\n');
    assert.deepEqual(prepared.initialMessages, ['{"type":"user"}']);
    assert.throws(() => parseClaudeStreamArgs(["--prompt", "hi"]), /after --/);
  });
});

describe("Pi live messages", () => {
  it("hands the message to Pi as a steer", async () => {
    const sent: Array<[string, unknown]> = [];
    const handler = createLiveMessageHandler({
      on: () => undefined,
      sendUserMessage: (content, options) => { sent.push([content, options]); },
    });
    const delivery: LiveMessageDelivery = await handler({ id: "msg-1", text: "skip the migration" });
    assert.equal(delivery, "steer");
    assert.deepEqual(sent, [["skip the migration", { deliverAs: "steer" }]]);
  });

  it("refuses when this Pi cannot take a message mid-run", async () => {
    await assert.rejects(createLiveMessageHandler({ on: () => undefined })({ id: "m", text: "x" }), /cannot take a message/);
  });
});
