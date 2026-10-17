import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import relayPermissionExtension, {
  PREVIEW_LIMIT,
  captureBrokerEnv,
  createToolCallHandler,
  questionFor,
  type PiToolCallEvent,
  type PiToolCallHandler,
} from "../src/permission-adapters/pi-extension.js";
import { BROKER_UNAVAILABLE, type PermissionQuestion } from "../src/permission-adapters/protocol.js";

const SECRET = "broker-secret";

/** A fake Pi ExtensionAPI that keeps the handlers an extension registers. */
function fakePi(): { handlers: PiToolCallHandler[]; on(event: "tool_call", handler: PiToolCallHandler): void } {
  const handlers: PiToolCallHandler[] = [];
  return { handlers, on: (event, handler) => { assert.equal(event, "tool_call"); handlers.push(handler); } };
}

const bash = (command: string, id = "call_1"): PiToolCallEvent => ({ toolName: "bash", toolCallId: id, input: { command } });

describe("Pi permission adapter (extension)", () => {
  let directory: string;
  let socketPath: string;
  let broker: Server;
  const seen: Array<Record<string, unknown>> = [];

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "relay-pi-ext-test-"));
    socketPath = join(directory, "broker.sock");
    // A fake broker: a command mentioning "rm" is denied with a note, anything else is allowed.
    broker = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, any>;
        seen.push(request);
        const decision = request.secret !== SECRET
          ? { behavior: "deny", message: "wrong secret" }
          : request.kind === "command" && String(request.input?.command).includes("rm")
            ? { behavior: "deny", message: "Not that command." }
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

  function loaded(env: Record<string, string>): PiToolCallHandler {
    const previous = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith("RELAY_PERMISSION_")) delete process.env[key];
    Object.assign(process.env, env);
    try {
      const pi = fakePi();
      relayPermissionExtension(pi);
      assert.equal(pi.handlers.length, 1);
      return pi.handlers[0];
    } finally {
      for (const key of Object.keys(process.env)) if (key.startsWith("RELAY_PERMISSION_")) delete process.env[key];
      Object.assign(process.env, previous);
    }
  }

  it("registers one tool_call handler and scrubs the broker env from the process", () => {
    process.env.RELAY_PERMISSION_SOCKET = socketPath;
    process.env.RELAY_PERMISSION_SECRET = SECRET;
    const pi = fakePi();
    relayPermissionExtension(pi);
    assert.equal(pi.handlers.length, 1);
    assert.equal(process.env.RELAY_PERMISSION_SOCKET, undefined);
    assert.equal(process.env.RELAY_PERMISSION_SECRET, undefined);
  });

  it("asks the broker about bash and lets an allowed command run", async () => {
    const handler = loaded({ RELAY_PERMISSION_SOCKET: socketPath, RELAY_PERMISSION_SECRET: SECRET });
    assert.equal(await handler(bash("echo hi", "call_echo")), undefined);
    const request = seen.find((entry) => entry.toolUseId === "call_echo");
    assert.deepEqual(request, { secret: SECRET, kind: "command", toolName: "bash", input: { command: "echo hi" }, toolUseId: "call_echo" });
  });

  it("blocks a denied command with the person's reason", async () => {
    const handler = loaded({ RELAY_PERMISSION_SOCKET: socketPath, RELAY_PERMISSION_SECRET: SECRET });
    assert.deepEqual(await handler(bash("rm -rf /")), { block: true, reason: "Not that command." });
  });

  it("asks about write and edit as file changes with previews, and lets a read pass unasked", async () => {
    const handler = loaded({ RELAY_PERMISSION_SOCKET: socketPath, RELAY_PERMISSION_SECRET: SECRET });
    const before = seen.length;
    assert.equal(await handler({ toolName: "read", toolCallId: "call_read", input: { path: "/tmp/a.txt" } }), undefined);
    assert.equal(seen.length, before, "a read asks no one");
    assert.equal(await handler({ toolName: "write", toolCallId: "call_write", input: { path: "note.txt", content: "hello" } }), undefined);
    const write = seen.find((entry) => entry.toolUseId === "call_write");
    assert.deepEqual(write, { secret: SECRET, kind: "file_change", toolName: "write", input: { path: "note.txt", content: "hello" }, toolUseId: "call_write" });
    assert.equal(await handler({ toolName: "edit", toolCallId: "call_edit", input: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } }), undefined);
    const edit = seen.find((entry) => entry.toolUseId === "call_edit");
    assert.deepEqual(edit?.input, { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] });
  });

  it("asks about a custom tool with its input", async () => {
    const handler = loaded({ RELAY_PERMISSION_SOCKET: socketPath, RELAY_PERMISSION_SECRET: SECRET });
    assert.equal(await handler({ toolName: "deploy", toolCallId: "call_deploy", input: { target: "prod" } }), undefined);
    const request = seen.find((entry) => entry.toolUseId === "call_deploy");
    assert.deepEqual(request, { secret: SECRET, kind: "tool", toolName: "deploy", input: { target: "prod" }, toolUseId: "call_deploy" });
  });

  it("blocks when the broker is down or not configured", async () => {
    const down = loaded({ RELAY_PERMISSION_SOCKET: join(directory, "missing.sock"), RELAY_PERMISSION_SECRET: SECRET });
    const verdict = await down(bash("echo hi"));
    assert.equal(verdict?.block, true);
    assert.match(String(verdict?.reason), new RegExp(BROKER_UNAVAILABLE));
    const unconfigured = loaded({});
    assert.equal((await unconfigured(bash("echo hi")))?.block, true);
  });

  it("blocks when asking throws", async () => {
    const handler = createToolCallHandler(async () => { throw new Error("boom"); });
    assert.deepEqual(await handler(bash("echo hi")), { block: true, reason: `${BROKER_UNAVAILABLE}: boom` });
  });

  it("caps file previews and carries bash's timeout", () => {
    const long = "x".repeat(PREVIEW_LIMIT + 100);
    const write = questionFor({ toolName: "write", input: { path: "big.txt", content: long } });
    const content = (write?.input as { content: string }).content;
    assert.ok(content.length < long.length);
    assert.match(content, /… \(100 more characters\)$/);
    const legacyEdit = questionFor({ toolName: "edit", input: { path: "a", oldText: long, newText: "n" } });
    assert.match((legacyEdit?.input as { oldText: string }).oldText, /… \(100 more characters\)$/);
    const timed = questionFor({ toolName: "bash", input: { command: "sleep 1", timeout: 5 } }) as PermissionQuestion;
    assert.deepEqual(timed.input, { command: "sleep 1", timeout: 5 });
    assert.equal(timed.toolUseId, undefined);
  });

  it("captures only the broker keys and leaves the rest of the environment alone", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", RELAY_PERMISSION_SOCKET: "/s", RELAY_PERMISSION_SECRET: "k", RELAY_BACKEND_URL: "http://b" };
    const captured = captureBrokerEnv(env);
    assert.deepEqual(captured, { RELAY_PERMISSION_SOCKET: "/s", RELAY_PERMISSION_SECRET: "k" });
    assert.deepEqual(env, { PATH: "/usr/bin", RELAY_BACKEND_URL: "http://b" });
  });
});
