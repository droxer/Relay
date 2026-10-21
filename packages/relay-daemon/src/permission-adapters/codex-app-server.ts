// Codex adapter. `codex exec` never asks for approval, so a run that asks a
// person drives `codex app-server` (JSON-RPC over stdio) instead: it starts or
// resumes a thread with approvals on request inside the workspace-write
// sandbox, runs one turn, relays each approval request to the run's broker,
// and prints the same JSONL `codex exec --json` would (codex-exec-events.ts).
// A `request_user_input` from the agent becomes a question prompt the person
// answers in Relay. Verified against codex-cli 0.163.0.
// Usage: node codex-app-server.js [-c key=value]... --cwd <dir>
//          [--model <id>] [--resume <thread id>] -- <prompt>
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { CodexExecEventTranslator, type ExecEvent } from "./codex-exec-events.js";
import type { PermissionAnswers, PermissionQuestionItem } from "relay-core";
import { askBroker, runtimeEnv, type PermissionAnswer, type PermissionQuestion } from "./protocol.js";

type Json = Record<string, unknown>;
type Ask = (question: PermissionQuestion) => Promise<PermissionAnswer>;

export interface CodexAdapterOptions {
  config: string[];
  cwd: string;
  model?: string;
  resume?: string;
  prompt: string;
}

/** Room for a person to read what changes; the backend caps the whole input. */
const DIFF_PREVIEW_LIMIT = 1_500;
const KILL_GRACE_MS = 2_000;
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

export function parseCodexAdapterArgs(argv: string[]): CodexAdapterOptions {
  const config: string[] = [];
  let cwd: string | undefined;
  let model: string | undefined;
  let resume: string | undefined;
  let index = 0;
  const value = (flag: string): string => {
    const next = argv[++index];
    if (next === undefined) throw new Error(`${flag} needs a value.`);
    return next;
  };
  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") break;
    if (arg === "-c" || arg === "--config") config.push(value(arg));
    else if (arg === "--cwd") cwd = value(arg);
    else if (arg === "--model") model = value(arg);
    else if (arg === "--resume") resume = value(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  const prompt = argv.slice(index + 1).join(" ");
  if (!cwd) throw new Error("--cwd is required.");
  if (!prompt) throw new Error("A prompt is required after --.");
  return { config, cwd, ...(model ? { model } : {}), ...(resume ? { resume } : {}), prompt };
}

/** Minimal JSON-RPC peer over a child's stdio. */
class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();

  constructor(
    private readonly child: ChildProcessByStdio<Writable, Readable, Readable>,
    handlers: { notification(method: string, params: Json): void; request(method: string, params: Json): Promise<Json | undefined> },
  ) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (!line.trim()) return;
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        process.stderr.write(`relay codex adapter: unreadable app-server line\n`);
        return;
      }
      const id = message.id as number | string | undefined;
      const method = typeof message.method === "string" ? message.method : undefined;
      if (method && id !== undefined) {
        void handlers.request(method, record(message.params)).then(
          (result) => this.send(result === undefined
            ? { id, error: { code: -32601, message: `Unsupported request: ${method}` } }
            : { id, result }),
          (error: unknown) => this.send({ id, error: { code: -32603, message: errorMessage(error) } }),
        );
      } else if (method) {
        handlers.notification(method, record(message.params));
      } else if (typeof id === "number" && this.pending.has(id)) {
        const waiter = this.pending.get(id)!;
        this.pending.delete(id);
        if (message.error) waiter.reject(new Error(str(record(message.error).message) || "app-server request failed"));
        else waiter.resolve(record(message.result));
      }
    });
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string): void {
    this.send({ method });
  }

  failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private send(message: Json): void {
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * Runs one turn and resolves the process exit code: 0 when the turn
 * completed, 1 when it failed or the app-server went away.
 */
export async function runCodexTurn(
  options: CodexAdapterOptions,
  io: { codexBin?: string; emit(event: ExecEvent): void; ask?: Ask; signal?: AbortSignal },
): Promise<number> {
  const ask = io.ask ?? ((question: PermissionQuestion) => askBroker(question));
  const translator = new CodexExecEventTranslator();
  const fileChanges = new Map<string, Json>();
  const emitAll = (events: ExecEvent[]): void => events.forEach(io.emit);
  // A `.cmd` shim on Windows only starts through a shell, which joins the
  // arguments itself, so each one is quoted for it there.
  const shell = process.platform === "win32";
  const argv = ["app-server", ...options.config.flatMap((entry) => ["-c", entry])];
  const child = spawn(io.codexBin ?? "codex", shell ? argv.map(cmdQuote) : argv, {
    cwd: options.cwd,
    env: runtimeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    shell,
  });
  // A write racing the app-server's exit must not crash the adapter.
  child.stdin.on("error", () => {});
  // app-server logs with ANSI colors; the run transcript keeps plain text.
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => process.stderr.write(chunk.replace(ANSI_ESCAPE, "")));
  let settled = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => { resolveDone = resolve; });
  const settle = (code: number): void => {
    if (settled) return;
    settled = true;
    resolveDone(code);
  };
  // Only this run's thread finishes the run; a sub-agent's turn does not.
  let threadId: string | undefined;
  const ownsThread = (params: Json): boolean => params.threadId === threadId;
  const peer = new RpcPeer(child, {
    notification: (method, params) => {
      if (method === "item/started" || method === "item/completed") rememberFileChange(record(params.item), fileChanges);
      emitAll(translator.notification(method, params));
      if (method === "turn/completed" && ownsThread(params)) {
        settle(record(params.turn).status === "completed" ? 0 : 1);
      }
    },
    request: (method, params) => answerServerRequest(method, params, ask, fileChanges),
  });
  const stop = (): void => {
    child.stdin.end();
    child.kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, KILL_GRACE_MS).unref();
  };
  child.on("error", (error) => {
    io.emit({ type: "error", message: `Could not start codex app-server: ${error.message}` });
    settle(1);
  });
  child.on("exit", (code, signal) => {
    if (settled) return;
    peer.failAll(new Error("codex app-server exited"));
    io.emit({ type: "error", message: `codex app-server exited before the turn finished (${signal ?? `code ${code}`}).` });
    settle(1);
  });
  const onAbort = (): void => settle(130);
  io.signal?.addEventListener("abort", onAbort, { once: true });

  void (async () => {
    try {
      await peer.request("initialize", {
        clientInfo: { name: "relay", title: "Relay", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      peer.notify("initialized");
      const threadSettings = {
        cwd: options.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        ...(options.model ? { model: options.model } : {}),
      };
      const started = options.resume
        ? await peer.request("thread/resume", { threadId: options.resume, ...threadSettings })
        : await peer.request("thread/start", threadSettings);
      threadId = str(record(started.thread).id);
      emitAll(translator.threadStarted(threadId));
      const turn = await peer.request("turn/start", {
        threadId,
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
      });
      translator.turnStarted(str(record(turn.turn).id));
    } catch (error) {
      io.emit({ type: "error", message: errorMessage(error) });
      settle(1);
    }
  })();

  try {
    return await done;
  } finally {
    io.signal?.removeEventListener("abort", onAbort);
    child.removeAllListeners("exit");
    stop();
  }
}

function rememberFileChange(item: Json, fileChanges: Map<string, Json>): void {
  if (item.type === "fileChange" && typeof item.id === "string") fileChanges.set(item.id, item);
}

/** The response to one server→client request, or undefined when unsupported. */
export async function answerServerRequest(
  method: string,
  params: Json,
  ask: Ask,
  fileChanges: Map<string, Json> = new Map(),
): Promise<Json | undefined> {
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const answer = await ask(commandQuestion(params));
      // Approve this one command only; never "acceptForSession".
      return { decision: answer.behavior === "allow" ? "accept" : "decline" };
    }
    case "item/fileChange/requestApproval": {
      const answer = await ask(fileChangeQuestion(params, fileChanges.get(str(params.itemId))));
      return { decision: answer.behavior === "allow" ? "accept" : "decline" };
    }
    case "item/permissions/requestApproval": {
      const answer = await ask({
        kind: "tool",
        toolName: "permissions",
        input: { cwd: params.cwd ?? null, permissions: params.permissions ?? null },
        toolUseId: str(params.itemId) || undefined,
        ...(str(params.reason) ? { reason: str(params.reason) } : {}),
      });
      // A grant lasts for this turn only.
      return { permissions: answer.behavior === "allow" ? requestedPermissions(params.permissions) : {}, scope: "turn" };
    }
    case "execCommandApproval": {
      const answer = await ask({
        kind: "command",
        toolName: "Bash",
        input: { command: array(params.command).map(String).join(" "), cwd: params.cwd ?? null },
        toolUseId: str(params.approvalId) || str(params.callId) || undefined,
        ...(str(params.reason) ? { reason: str(params.reason) } : {}),
      });
      return { decision: legacyDecision(answer) };
    }
    case "applyPatchApproval": {
      const changes = Object.entries(record(params.fileChanges)).map(([path, change]) => ({ path, kind: str(record(change).type) }));
      const answer = await ask({
        kind: "file_change",
        toolName: "apply_patch",
        input: { changes, ...(str(params.grantRoot) ? { grantRoot: str(params.grantRoot) } : {}) },
        toolUseId: str(params.callId) || undefined,
        ...(str(params.reason) ? { reason: str(params.reason) } : {}),
      });
      return { decision: legacyDecision(answer) };
    }
    // The agent asks the person something: each question with its offered
    // answers goes to Relay as one prompt; a skipped prompt answers nothing.
    case "item/tool/requestUserInput": {
      const questions = userInputQuestions(params.questions);
      if (!questions) return { answers: {} };
      const answer = await ask({
        kind: "question",
        toolName: "request_user_input",
        input: { questions: params.questions },
        toolUseId: str(params.itemId) || undefined,
        questions,
      });
      return { answers: userInputAnswers(answer) };
    }
    // Relay has no channel for MCP forms mid-run.
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/call":
      return { contentItems: [], success: false };
    default:
      return undefined;
  }
}

function commandQuestion(params: Json): PermissionQuestion {
  return {
    kind: "command",
    toolName: "Bash",
    input: {
      command: str(params.command),
      cwd: params.cwd ?? null,
      ...(params.networkApprovalContext ? { network: params.networkApprovalContext } : {}),
      ...(params.kind === "writeStdin" ? { stdin: true } : {}),
    },
    toolUseId: str(params.approvalId) || str(params.itemId) || undefined,
    ...(str(params.reason) ? { reason: str(params.reason) } : {}),
  };
}

function fileChangeQuestion(params: Json, item: Json | undefined): PermissionQuestion {
  const changes = array(item?.changes).map((change) => record(change));
  const diff = changes.map((change) => str(change.diff)).filter(Boolean).join("\n");
  return {
    kind: "file_change",
    toolName: "apply_patch",
    input: {
      changes: changes.map((change) => ({ path: str(change.path), kind: str(record(change.kind).type) })),
      ...(diff ? { diff: diff.length > DIFF_PREVIEW_LIMIT ? `${diff.slice(0, DIFF_PREVIEW_LIMIT)}…` : diff } : {}),
      ...(str(params.grantRoot) ? { grantRoot: str(params.grantRoot) } : {}),
    },
    toolUseId: str(params.itemId) || undefined,
    ...(str(params.reason) ? { reason: str(params.reason) } : {}),
  };
}

/** Codex's `request_user_input` questions in the broker's shape, keyed by their ids. */
export function userInputQuestions(value: unknown): PermissionQuestionItem[] | undefined {
  const questions = array(value).flatMap((raw) => {
    const question = record(raw);
    const id = str(question.id);
    const text = str(question.question) || str(question.header);
    if (!id || !text) return [];
    const options = array(question.options).flatMap((option) => {
      const label = str(record(option).label);
      const description = str(record(option).description);
      return label ? [{ label, ...(description ? { description } : {}) }] : [];
    });
    return [{ id, text, options }];
  });
  return questions.length ? questions : undefined;
}

/** `{questionId: {answers: [...]}}`, as the app-server reads it. */
export function userInputAnswers(answer: PermissionAnswer): Record<string, { answers: string[] }> {
  const answers: PermissionAnswers = answer.behavior === "allow" && answer.answers ? answer.answers : {};
  return Object.fromEntries(Object.entries(answers).map(([id, picks]) => [id, { answers: picks }]));
}

/** One argument as cmd.exe will hand it back whole. */
export function cmdQuote(argument: string): string {
  return /[\s"&|<>^()]/.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument;
}

/** Grant what was asked: the requested profile minus its absent parts. */
function requestedPermissions(value: unknown): Json {
  return Object.fromEntries(Object.entries(record(value)).filter(([, part]) => part !== null && part !== undefined));
}

function legacyDecision(answer: PermissionAnswer): unknown {
  return answer.behavior === "allow"
    ? "approved"
    : { denied: { rejection: answer.message ?? "Denied in Relay." } };
}

function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  let options: CodexAdapterOptions;
  try {
    options = parseCodexAdapterArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`relay codex adapter: ${errorMessage(error)}\n`);
    process.exit(2);
  }
  const abort = new AbortController();
  let exitCode: number | undefined;
  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    process.once(signal, () => {
      exitCode = code;
      abort.abort(signal);
    });
  }
  const code = await runCodexTurn(options, {
    codexBin: process.env.RELAY_CODEX_BIN || "codex",
    emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    signal: abort.signal,
  });
  process.exitCode = exitCode ?? code;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
