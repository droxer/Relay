import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { PERMISSION_TEXT_LIMIT } from "relay-core";
import { handleMessage } from "../src/permission-adapters/claude-mcp.js";
import { QUESTION_TEXT_LIMIT, questionId } from "../src/permission-adapters/protocol.js";
import { parseQuestions } from "../src/permission-broker.js";

const SERVER = fileURLToPath(new URL("../src/permission-adapters/claude-mcp.js", import.meta.url));
const SECRET = "broker-secret";

interface Rpc {
  send(message: Record<string, unknown>): void;
  response(id: number): Promise<Record<string, any>>;
  stdout: string[];
  close(): void;
}

function startMcp(env: Record<string, string>): Rpc {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  const stdout: string[] = [];
  const waiting = new Map<number, (message: Record<string, any>) => void>();
  const received = new Map<number, Record<string, any>>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    stdout.push(line);
    const message = JSON.parse(line) as Record<string, any>;
    const resolve = waiting.get(message.id);
    if (resolve) resolve(message);
    else received.set(message.id, message);
  });
  return {
    stdout,
    send: (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    response: (id) => new Promise((resolve) => {
      const early = received.get(id);
      if (early) resolve(early);
      else waiting.set(id, resolve);
    }),
    close: () => child.kill(),
  };
}

function toolText(response: Record<string, any>): Record<string, unknown> {
  return JSON.parse(response.result.content[0].text) as Record<string, unknown>;
}

describe("Claude permission adapter (MCP server)", () => {
  let directory: string;
  let socketPath: string;
  let addressFile: string;
  let broker: Server;
  const seen: Array<Record<string, unknown>> = [];
  const brokerEnv = () => ({ RELAY_PERMISSION_FILE: addressFile });

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "relay-mcp-test-"));
    socketPath = join(directory, "broker.sock");
    addressFile = join(directory, "broker.json");
    writeFileSync(addressFile, JSON.stringify({ socket: socketPath, secret: SECRET }));
    // A fake broker: Bash is denied with a note, a question is answered, anything else is allowed.
    broker = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>;
        seen.push(request);
        const decision = request.secret !== SECRET
          ? { behavior: "deny", message: "wrong secret" }
          : request.toolName === "Bash"
            ? { behavior: "deny", message: "Not that command." }
            : request.kind === "question"
              ? { behavior: "allow", answers: { "Which database?": ["Postgres", "SQLite"] } }
              : { behavior: "allow" };
        socket.end(`${JSON.stringify(decision)}\n`);
      });
    });
    await new Promise<void>((resolve) => broker.listen(socketPath, resolve));
  });

  after(async () => {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  it("initializes, lists the approve tool, and answers ping and unknown methods", async () => {
    const rpc = startMcp(brokerEnv());
    try {
      rpc.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
      const init = await rpc.response(1);
      assert.deepEqual(init.result, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "relay", version: "0.1.0" },
      });
      rpc.send({ method: "notifications/initialized" });
      rpc.send({ id: 2, method: "tools/list" });
      const list = await rpc.response(2);
      assert.equal(list.result.tools.length, 1);
      assert.equal(list.result.tools[0].name, "approve");
      assert.deepEqual(list.result.tools[0].inputSchema.required, ["tool_name", "input"]);
      rpc.send({ id: 3, method: "ping" });
      assert.deepEqual((await rpc.response(3)).result, {});
      rpc.send({ id: 4, method: "resources/list" });
      assert.equal((await rpc.response(4)).error.code, -32601);
      // The notification produced nothing: only the four responses reached stdout.
      assert.equal(rpc.stdout.length, 4);
    } finally {
      rpc.close();
    }
  });

  it("defaults the protocol version when the client names none", async () => {
    const rpc = startMcp(brokerEnv());
    try {
      rpc.send({ id: 1, method: "initialize", params: {} });
      assert.equal((await rpc.response(1)).result.protocolVersion, "2024-11-05");
    } finally {
      rpc.close();
    }
  });

  it("relays allow with the original input and deny with the broker's message", async () => {
    const rpc = startMcp(brokerEnv());
    try {
      const input = { file_path: "/tmp/a.txt", content: "hi" };
      rpc.send({ id: 5, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Write", input, tool_use_id: "toolu_1" } } });
      rpc.send({ id: 6, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "rm -rf /" } } } });
      assert.deepEqual(toolText(await rpc.response(5)), { behavior: "allow", updatedInput: input });
      assert.deepEqual(toolText(await rpc.response(6)), { behavior: "deny", message: "Not that command." });
      const write = seen.find((request) => request.toolName === "Write");
      assert.deepEqual(write, { secret: SECRET, kind: "file_change", toolName: "Write", input, toolUseId: "toolu_1" });
    } finally {
      rpc.close();
    }
  });

  it("answers AskUserQuestion with the person's picks on updatedInput", async () => {
    const rpc = startMcp(brokerEnv());
    try {
      const input = {
        questions: [{ question: "Which database?", header: "Database", multiSelect: true, options: [{ label: "Postgres", description: "shared" }, { label: "SQLite" }] }],
      };
      rpc.send({ id: 9, method: "tools/call", params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input, tool_use_id: "toolu_q" } } });
      assert.deepEqual(toolText(await rpc.response(9)), {
        behavior: "allow",
        updatedInput: { ...input, answers: { "Which database?": "Postgres, SQLite" } },
      });
      const asked = seen.find((request) => request.toolUseId === "toolu_q");
      assert.equal(asked?.kind, "question");
      assert.deepEqual(asked?.questions, [
        { id: "Which database?", text: "Which database?", options: [{ label: "Postgres", description: "shared" }, { label: "SQLite" }], multiSelect: true },
      ]);
    } finally {
      rpc.close();
    }
  });

  it("keys answers by Claude's own question text, even one the broker trims or cuts", async () => {
    const long = `${"Why ".repeat(200)}?`;
    const input = { questions: [{ question: "Which database?\n", options: [{ label: "Postgres" }] }, { question: long, options: [{ label: "Because" }] }] };
    const response = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve", arguments: { tool_name: "AskUserQuestion", input } } },
      async (question) => {
        // Use the real broker parser so answer ids include its normalization.
        const stored = parseQuestions(question.questions)!;
        return { behavior: "allow", answers: { [stored[0].id]: ["Postgres"], [stored[1].id]: ["Because"] } };
      },
    );
    const text = (response?.result as { content: Array<{ text: string }> }).content[0].text;
    assert.deepEqual(JSON.parse(text).updatedInput.answers, { "Which database?\n": "Postgres", [long]: "Because" });
    assert.equal(questionId(long).length, QUESTION_TEXT_LIMIT - 1);
    assert.equal(questionId("x".repeat(QUESTION_TEXT_LIMIT + 1)).length, QUESTION_TEXT_LIMIT);
    assert.equal(QUESTION_TEXT_LIMIT, PERMISSION_TEXT_LIMIT);
  });

  it("denies when the broker cannot be reached", async () => {
    const missing = join(directory, "missing.json");
    writeFileSync(missing, JSON.stringify({ socket: join(directory, "missing.sock"), secret: SECRET }));
    const rpc = startMcp({ RELAY_PERMISSION_FILE: missing });
    try {
      rpc.send({ id: 7, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Write", input: {} } } });
      const answer = toolText(await rpc.response(7));
      assert.equal(answer.behavior, "deny");
      assert.match(String(answer.message), /Relay could not ask a person/);
    } finally {
      rpc.close();
    }
  });

  it("denies when no broker is configured", async () => {
    const rpc = startMcp({});
    try {
      rpc.send({ id: 8, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Write", input: {} } } });
      assert.equal(toolText(await rpc.response(8)).behavior, "deny");
    } finally {
      rpc.close();
    }
  });
});
