import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { answerServerRequest, cmdQuote, parseCodexAdapterArgs, userInputQuestions } from "../src/permission-adapters/codex-app-server.js";
import { CodexExecEventTranslator } from "../src/permission-adapters/codex-exec-events.js";
import type { PermissionQuestion } from "../src/permission-adapters/protocol.js";

const ADAPTER = fileURLToPath(new URL("../src/permission-adapters/codex-app-server.js", import.meta.url));
const SECRET = "codex-secret";

// A stand-in `codex app-server`: logs every client message, answers the
// handshake, then plays one turn with a command and a file-change approval.
const FAKE_APP_SERVER = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const log = (entry) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const note = (method, params) => send({ method, params });
const mode = process.env.FAKE_MODE || "turn";
const waiting = new Map();
const ask = (id, method, params) => new Promise((resolve) => { waiting.set(id, resolve); send({ id, method, params }); });
let thread = "thr_main";
const turn = "turn_1";
let T = { threadId: thread, turnId: turn };
log({ argv: process.argv.slice(2) });
process.on("SIGTERM", () => { log({ signal: "SIGTERM" }); process.exit(0); });
async function playTurn() {
  note("turn/started", { threadId: thread, turn: { id: turn, status: "inProgress", items: [] } });
  if (mode === "hang") return;
  if (mode === "invalid_frames") {
    for (const value of [null, [], "noise", 42]) send(value);
  }
  if (mode === "crash") {
    // The runtime dies while a person has not answered yet.
    send({ id: "srv_crash", method: "item/commandExecution/requestApproval", params: { ...T, itemId: "c9", kind: "command", command: "make", cwd: "/w" } });
    setTimeout(() => process.exit(1), 200);
    return;
  }
  note("item/started", { ...T, item: { type: "userMessage", id: "u1", content: [] } });
  note("item/completed", { ...T, item: { type: "agentMessage", id: "m1", text: "Working." } });
  const command = { type: "commandExecution", id: "c1", command: "touch /outside", cwd: "/w", status: "inProgress", aggregatedOutput: null, exitCode: null, commandActions: [] };
  note("item/started", { ...T, item: command });
  const commandAnswer = await ask("srv_1", "item/commandExecution/requestApproval", { ...T, itemId: "c1", kind: "command", command: "touch /outside", cwd: "/w", reason: "write outside the workspace", startedAtMs: 1, environmentId: null });
  log({ answered: "command", result: commandAnswer });
  const declined = commandAnswer.decision !== "accept";
  note("item/completed", { ...T, item: { ...command, status: declined ? "declined" : "completed", aggregatedOutput: declined ? "" : "ok\\n", exitCode: declined ? null : 0 } });
  const change = { type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: "/outside/a.txt", kind: { type: "add" }, diff: "+hi" }] };
  note("item/started", { ...T, item: change });
  const fileAnswer = await ask(7, "item/fileChange/requestApproval", { ...T, itemId: "f1", startedAtMs: 2, reason: null, grantRoot: null });
  log({ answered: "file", result: fileAnswer });
  note("item/completed", { ...T, item: { ...change, status: fileAnswer.decision === "accept" ? "completed" : "declined" } });
  note("item/started", { threadId: "thr_child", turnId: "t_child", item: { type: "agentMessage", id: "x", text: "child" } });
  note("thread/tokenUsage/updated", { ...T, tokenUsage: { total: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 }, last: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5 }, modelContextWindow: null } });
  note("turn/completed", { threadId: thread, turn: mode === "fail"
    ? { id: turn, status: "failed", items: [], error: { message: "model refused" } }
    : { id: turn, status: "completed", items: [], error: null } });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === undefined && waiting.has(message.id)) { waiting.get(message.id)(message.result); waiting.delete(message.id); return; }
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake", codexHome: "/h", platformFamily: "unix", platformOs: "macos" } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    if (message.params.threadId) { thread = message.params.threadId; T = { threadId: thread, turnId: turn }; }
    note("configWarning", { summary: "Codex is ignoring 1 unrecognized configuration setting.", details: null });
    send({ id: message.id, result: { thread: { id: message.params.threadId || thread } } });
  }
  if (message.method === "turn/start") { send({ id: message.id, result: { turn: { id: turn } } }); void playTurn(); }
});
`;

interface Run {
  code: number | null;
  stdout: Array<Record<string, unknown>>;
  log: Array<Record<string, any>>;
}

describe("Codex app-server adapter", () => {
  let directory: string;
  let fake: string;
  let socketPath: string;
  let addressFile: string;
  let broker: Server;
  const questions: Array<Record<string, unknown>> = [];

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), "relay-codex-adapter-"));
    fake = join(directory, "codex");
    writeFileSync(fake, FAKE_APP_SERVER);
    chmodSync(fake, 0o755);
    socketPath = join(directory, "broker.sock");
    addressFile = join(directory, "broker.json");
    writeFileSync(addressFile, JSON.stringify({ socket: socketPath, secret: SECRET }));
    // Allows commands, denies file changes.
    broker = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const question = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Record<string, unknown>;
        questions.push(question);
        socket.end(`${JSON.stringify(question.kind === "command" ? { behavior: "allow" } : { behavior: "deny", message: "No." })}\n`);
      });
    });
    await new Promise<void>((resolve) => broker.listen(socketPath, resolve));
  });

  after(async () => {
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  function run(args: string[], env: Record<string, string> = {}, onSpawn?: (kill: () => void) => void): Promise<Run> {
    const logFile = join(directory, `log-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(logFile, "");
    const child = spawn(process.execPath, [ADAPTER, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        RELAY_CODEX_BIN: fake,
        RELAY_PERMISSION_FILE: addressFile,
        FAKE_LOG: logFile,
        ...env,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    onSpawn?.(() => child.kill("SIGTERM"));
    return new Promise((resolve) => child.on("close", (code) => resolve({
      code,
      stdout: stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
      log: readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>),
    })));
  }

  it("prints exactly the JSONL codex exec --json would, and asks before escalations", async () => {
    const result = await run(["-c", "features.multi_agent=true", "--cwd", directory, "--model", "gpt-test", "--", "do", "it"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout, [
      { type: "thread.started", thread_id: "thr_main" },
      { type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Working." } },
      { type: "item.started", item: { id: "item_2", type: "command_execution", command: "touch /outside", aggregated_output: "", exit_code: null, status: "in_progress" } },
      { type: "item.completed", item: { id: "item_2", type: "command_execution", command: "touch /outside", aggregated_output: "ok\n", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: "/outside/a.txt", kind: "add" }], status: "declined" } },
      { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 5 } },
    ]);
    // Launch: config overrides reach the app-server; the thread asks on request
    // inside the workspace-write sandbox; the prompt is one text input.
    assert.deepEqual(result.log[0], { argv: ["app-server", "-c", "features.multi_agent=true"] });
    const start = result.log.find((entry) => entry.method === "thread/start");
    assert.deepEqual(start?.params, { cwd: directory, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write", model: "gpt-test" });
    const turn = result.log.find((entry) => entry.method === "turn/start");
    assert.deepEqual(turn?.params, { threadId: "thr_main", input: [{ type: "text", text: "do it", text_elements: [] }] });
    // Approve once, never for the session; a denial declines.
    assert.deepEqual(result.log.find((entry) => entry.answered === "command")?.result, { decision: "accept" });
    assert.deepEqual(result.log.find((entry) => entry.answered === "file")?.result, { decision: "decline" });
    const command = questions.find((question) => question.kind === "command");
    assert.deepEqual(command, {
      secret: SECRET, kind: "command", toolName: "Bash", input: { command: "touch /outside", cwd: "/w" }, toolUseId: "c1", reason: "write outside the workspace",
    });
    const file = questions.find((question) => question.kind === "file_change");
    assert.deepEqual(file, {
      secret: SECRET, kind: "file_change", toolName: "apply_patch", input: { changes: [{ path: "/outside/a.txt", kind: "add" }], diff: "+hi" }, toolUseId: "f1",
    });
  });

  it("ignores non-object JSON frames and finishes the turn", async () => {
    const result = await run(["--cwd", directory, "--", "go"], { FAKE_MODE: "invalid_frames" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.at(-1)?.type, "turn.completed");
    assert.ok(result.log.some((entry) => entry.signal === "SIGTERM"));
  });

  it("resumes the given thread instead of starting one", async () => {
    const result = await run(["--cwd", directory, "--resume", "thr_old", "--", "continue"]);
    assert.equal(result.code, 0);
    assert.ok(result.log.some((entry) => entry.method === "thread/resume" && entry.params.threadId === "thr_old"));
    assert.ok(!result.log.some((entry) => entry.method === "thread/start"));
    assert.deepEqual(result.stdout[0], { type: "thread.started", thread_id: "thr_old" });
  });

  it("exits non-zero with turn.failed when the turn fails", async () => {
    const result = await run(["--cwd", directory, "--", "go"], { FAKE_MODE: "fail" });
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout.at(-1), { type: "turn.failed", error: { message: "model refused" } });
  });

  it("declines every approval when the broker is unreachable", async () => {
    const missing = join(directory, "missing.json");
    writeFileSync(missing, JSON.stringify({ socket: join(directory, "missing.sock"), secret: SECRET }));
    const result = await run(["--cwd", directory, "--", "go"], { RELAY_PERMISSION_FILE: missing });
    assert.equal(result.code, 0);
    assert.deepEqual(result.log.find((entry) => entry.answered === "command")?.result, { decision: "decline" });
  });

  it("stops the app-server promptly when the run is aborted", async () => {
    const started = Date.now();
    const result = await run(["--cwd", directory, "--", "go"], { FAKE_MODE: "hang" }, (kill) => setTimeout(kill, 300));
    assert.equal(result.code, 143);
    assert.ok(Date.now() - started < 2_000);
    assert.ok(result.log.some((entry) => entry.signal === "SIGTERM"));
  });

  it("hangs up an open question and exits when the app-server dies before the person answers", async () => {
    // A broker that takes the question and never answers, like a person away.
    const silentSocket = join(directory, "silent.sock");
    const silentFile = join(directory, "silent.json");
    writeFileSync(silentFile, JSON.stringify({ socket: silentSocket, secret: SECRET }));
    let hungUp = false;
    const silent = createServer((socket) => socket.resume().on("close", () => { hungUp = true; }));
    await new Promise<void>((resolve) => silent.listen(silentSocket, resolve));
    try {
      const started = Date.now();
      const result = await run(["--cwd", directory, "--", "go"], { FAKE_MODE: "crash", RELAY_PERMISSION_FILE: silentFile });
      assert.equal(result.code, 1);
      assert.ok(Date.now() - started < 5_000, "the adapter must not wait on a question nobody can act on");
      for (let tries = 0; tries < 100 && !hungUp; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(hungUp, "the broker sees the hang-up, so it withdraws the prompt");
    } finally {
      silent.close();
    }
  });

  it("parses exec-style options and requires a prompt", () => {
    assert.deepEqual(parseCodexAdapterArgs(["-c", "a=1", "--cwd", "/w", "--resume", "r", "--", "hello", "there"]),
      { config: ["a=1"], cwd: "/w", resume: "r", prompt: "hello there" });
    assert.throws(() => parseCodexAdapterArgs(["--cwd", "/w", "--"]), /prompt/);
  });

  it("asks the person the agent's request_user_input questions and relays their answers", async () => {
    const params = {
      threadId: "t", turnId: "u", itemId: "q1",
      questions: [
        { id: "db", header: "Database", question: "Which database?", isOther: true, isSecret: false, options: [{ label: "Postgres", description: "shared" }, { label: "SQLite", description: "local" }] },
        { id: "name", header: "Name", question: "", isOther: true, isSecret: false, options: null },
      ],
    };
    const asked: Array<Record<string, unknown>> = [];
    const answered = await answerServerRequest("item/tool/requestUserInput", params, async (question) => {
      asked.push(question as unknown as Record<string, unknown>);
      return { behavior: "allow", answers: { db: ["SQLite"], name: ["relay"] } };
    });
    assert.deepEqual(answered, { answers: { db: { answers: ["SQLite"] }, name: { answers: ["relay"] } } });
    assert.equal(asked[0].kind, "question");
    assert.equal(asked[0].toolUseId, "q1");
    assert.deepEqual(userInputQuestions(params.questions), [
      { id: "db", text: "Which database?", options: [{ label: "Postgres", description: "shared" }, { label: "SQLite", description: "local" }] },
      { id: "name", text: "Name", options: [] },
    ]);
    // A skipped prompt answers nothing, and a malformed one never asks.
    assert.deepEqual(await answerServerRequest("item/tool/requestUserInput", params, async () => ({ behavior: "deny" })), { answers: {} });
    assert.deepEqual(await answerServerRequest("item/tool/requestUserInput", { questions: "?" }, async () => { throw new Error("never"); }), { answers: {} });
  });

  it("quotes app-server arguments for cmd.exe only when they need it", () => {
    assert.equal(cmdQuote("app-server"), "app-server");
    assert.equal(cmdQuote("model_reasoning_effort=high"), "model_reasoning_effort=high");
    assert.equal(cmdQuote('notify=["say","done"]'), '"notify=[\\"say\\",\\"done\\"]"');
    assert.equal(cmdQuote("a b"), '"a b"');
  });

  it("maps legacy and permission approvals without ever granting a session", async () => {
    const allow = async () => ({ behavior: "allow" as const });
    const deny = async () => ({ behavior: "deny" as const, message: "nope" });
    assert.deepEqual(await answerServerRequest("execCommandApproval", { command: ["ls", "-la"], cwd: "/w", callId: "call_1" }, allow), { decision: "approved" });
    assert.deepEqual(await answerServerRequest("applyPatchApproval", { fileChanges: {}, callId: "call_2" }, deny), { decision: { denied: { rejection: "nope" } } });
    assert.deepEqual(
      await answerServerRequest("item/permissions/requestApproval", { itemId: "p", cwd: "/w", reason: null, permissions: { network: { enabled: true }, fileSystem: null } }, allow),
      { permissions: { network: { enabled: true } }, scope: "turn" },
    );
    assert.deepEqual(await answerServerRequest("item/permissions/requestApproval", { itemId: "p", permissions: {} }, deny), { permissions: {}, scope: "turn" });
    assert.deepEqual(await answerServerRequest("mcpServer/elicitation/request", {}, allow), { action: "decline", content: null, _meta: null });
    assert.equal(await answerServerRequest("account/chatgptAuthTokens/refresh", {}, allow), undefined);
  });

  it("asks a person before an MCP tool call and runs it once on allow", async () => {
    const params = {
      serverName: "linear",
      threadId: "thr",
      mode: "form",
      message: "Allow the linear MCP server to run tool \"create_issue\"?",
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "create_issue", connector_name: "Linear", tool_params: { title: "Bug" } },
    };
    const asked: PermissionQuestion[] = [];
    const answer = (behavior: "allow" | "deny") => async (question: PermissionQuestion) => {
      asked.push(question);
      return behavior === "allow" ? { behavior } : { behavior, message: "no" };
    };
    assert.deepEqual(await answerServerRequest("mcpServer/elicitation/request", params, answer("allow")), { action: "accept", content: {}, _meta: null });
    assert.deepEqual(await answerServerRequest("mcpServer/elicitation/request", params, answer("deny")), { action: "decline", content: null, _meta: null });
    assert.deepEqual(asked[0], {
      kind: "tool",
      toolName: "mcp__linear__create_issue",
      input: { server: "linear", tool: "create_issue", connector: "Linear", arguments: { title: "Bug" } },
      reason: "Allow the linear MCP server to run tool \"create_issue\"?",
    });
    // Any other MCP form still declines without asking.
    const before = asked.length;
    assert.deepEqual(
      await answerServerRequest("mcpServer/elicitation/request", { ...params, _meta: { codex_approval_kind: "other" } }, answer("allow")),
      { action: "decline", content: null, _meta: null },
    );
    assert.equal(asked.length, before);
  });
});

describe("Codex exec event translation", () => {
  it("renders collaboration calls in exec's collab_tool_call shape", () => {
    const translator = new CodexExecEventTranslator();
    translator.threadStarted("thr");
    const [event] = translator.notification("item/completed", {
      threadId: "thr",
      turnId: "t",
      item: {
        type: "collabAgentToolCall", id: "c", tool: "spawnAgent", status: "completed", senderThreadId: "thr",
        receiverThreadIds: ["child"], prompt: "Review", model: null, reasoningEffort: null,
        agentsStates: { child: { status: "pendingInit", message: null } },
      },
    });
    assert.deepEqual(event, {
      type: "item.completed",
      item: {
        id: "item_0", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: "thr", receiver_thread_ids: ["child"],
        prompt: "Review", agents_states: { child: { status: "pending_init", message: null } }, status: "completed",
      },
    });
  });

  it("reports only this turn's tokens on a resumed thread", () => {
    const translator = new CodexExecEventTranslator();
    translator.threadStarted("thr");
    translator.turnStarted("t");
    const breakdown = (input: number, output: number) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 });
    translator.notification("thread/tokenUsage/updated", { threadId: "thr", turnId: "t", tokenUsage: { total: breakdown(1100, 110), last: breakdown(100, 10) } });
    translator.notification("thread/tokenUsage/updated", { threadId: "thr", turnId: "t", tokenUsage: { total: breakdown(1300, 130), last: breakdown(200, 20) } });
    const events = translator.notification("turn/completed", { threadId: "thr", turn: { id: "t", status: "completed" } });
    assert.deepEqual(events.at(-1), {
      type: "turn.completed",
      usage: { input_tokens: 300, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 0 },
    });
  });
});
