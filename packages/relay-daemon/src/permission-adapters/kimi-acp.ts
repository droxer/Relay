// Kimi adapter: runs one prompt through `kimi acp` (Agent Client Protocol,
// JSON-RPC over stdio) so Kimi's approval requests reach a person, and prints
// the same stream-json lines `kimi -p --output-format stream-json` prints, so
// KimiStreamRenderer and the run's log parsing need no second format.
//
// `kimi -p` forces Kimi's "Never Ask" permission mode and never asks anyone.
// Here the session runs in ACP mode `yolo`, which is Kimi's "Ask When
// Needed": routine edits and commands run, risky actions still ask. Each ask
// (`session/request_permission`) becomes one broker question; the answer picks
// the one-shot option (allow_once / reject_once), never an "always" rule.
// Verified against kimi-code 2.0.2; re-check `ASK_WHEN_NEEDED_MODE` and the
// AskUserQuestion option ids on upgrade.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { PermissionQuestionItem } from "relay-core";
import { askBroker, questionId, runtimeEnv, type PermissionAnswer, type PermissionQuestion, type PermissionQuestionKind } from "./protocol.js";

/** Asks about one request; `signal` fires once the prompt is over and nobody can act on the answer. */
export type AskBroker = (question: PermissionQuestion, signal?: AbortSignal) => Promise<PermissionAnswer>;

/**
 * ACP mode id of Kimi's "Ask When Needed" permission mode. The descriptions
 * `kimi acp` advertises read the other way ("yolo: Auto-approve everything"),
 * but they are stale: kimi-code 2.0.2's `acpModeToToggles` maps ACP `yolo` to
 * its `yolo` permission level, which its UI labels "Ask When Needed" and the
 * `-y, --yolo` flag documents as "risky actions, questions, and plans still
 * ask"; ACP `auto` is "Never Ask" — what `kimi -p` runs. Re-check on upgrade.
 */
export const ASK_WHEN_NEEDED_MODE = "yolo";
const ACP_PROTOCOL_VERSION = 1;
const KILL_GRACE_MS = 2_000;

export interface KimiAcpOptions {
  /** The Kimi executable; `kimi` on PATH by default. */
  kimiCommand: string;
  /** Absolute workspace the session works in. */
  cwd: string;
  /** A Kimi model alias to select; omitted keeps Kimi's own default. */
  model?: string;
  prompt: string;
}

export interface KimiAcpIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  ask: AskBroker;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface StreamToolCall {
  type: "function";
  id: string;
  function: { name: string; arguments: string };
}

/**
 * Mirrors kimi-code's PromptJsonWriter: assistant text and tool calls collect
 * until a tool result (or the end of the turn) flushes them as one message.
 */
export class StreamJsonWriter {
  private assistantText = "";
  private toolCalls: StreamToolCall[] = [];
  /** Calls already printed; a late update must not print them twice. */
  private readonly printed = new Set<string>();

  constructor(private readonly out: { write(text: string): unknown }) {}

  version(version: string): void {
    this.line({ role: "meta", type: "system.version", version });
  }

  assistantDelta(delta: string): void {
    this.assistantText += delta;
  }

  toolCall(id: string, name: string, args: string): void {
    if (this.printed.has(id)) return;
    const existing = this.toolCalls.find((call) => call.id === id);
    if (existing) {
      existing.function = { name: name || existing.function.name, arguments: args };
      return;
    }
    this.toolCalls.push({ type: "function", id, function: { name, arguments: args } });
  }

  toolResult(id: string, content: string): void {
    this.flush();
    this.line({ role: "tool", tool_call_id: id, content });
  }

  flush(): void {
    if (this.assistantText.length === 0 && this.toolCalls.length === 0) return;
    this.line({
      role: "assistant",
      content: this.assistantText.length > 0 ? this.assistantText : undefined,
      tool_calls: this.toolCalls.length > 0 ? [...this.toolCalls] : undefined,
    });
    for (const call of this.toolCalls) this.printed.add(call.id);
    this.assistantText = "";
    this.toolCalls = [];
  }

  resumeHint(sessionId: string): void {
    const command = `kimi -r ${sessionId}`;
    this.line({ role: "meta", type: "session.resume_hint", session_id: sessionId, command });
  }

  private line(message: Record<string, unknown>): void {
    this.out.write(`${JSON.stringify(message)}\n`);
  }
}

interface KnownToolCall {
  name: string;
  kind?: string;
  rawInput?: unknown;
  locations?: unknown;
  done: boolean;
}

/** Translates `session/update` notifications into stream-json lines. */
export class SessionUpdateTranslator {
  private readonly calls = new Map<string, KnownToolCall>();

  constructor(private readonly writer: StreamJsonWriter) {}

  toolCall(id: string): KnownToolCall | undefined {
    return this.calls.get(id);
  }

  apply(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = contentText(update.content);
        if (text) this.writer.assistantDelta(text);
        return;
      }
      case "tool_call":
      case "tool_call_update":
        this.applyToolCall(update);
        return;
      default:
        // Thinking, plans, usage, modes, and commands stay off stdout, as in `kimi -p`.
        return;
    }
  }

  private applyToolCall(update: Record<string, unknown>): void {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!id) return;
    const known = this.calls.get(id);
    const call: KnownToolCall = known ?? {
      // The first notification names the tool; later titles are progress text.
      name: typeof update.title === "string" && update.title ? update.title : "tool",
      done: false,
    };
    if (typeof update.kind === "string") call.kind = update.kind;
    if (update.rawInput !== undefined) call.rawInput = update.rawInput;
    if (update.locations !== undefined && update.locations !== null) call.locations = update.locations;
    this.calls.set(id, call);
    if (call.done) return;
    const status = update.status;
    if (status === "completed" || status === "failed") {
      call.done = true;
      this.writer.toolCall(id, call.name, argumentsText(call.rawInput, update.content));
      this.writer.toolResult(id, outputText(update.rawOutput, update.content));
      return;
    }
    if (update.rawInput !== undefined || update.content !== undefined || !known) {
      this.writer.toolCall(id, call.name, argumentsText(call.rawInput, update.content));
    }
  }
}

/** One `session/request_permission` in, the ACP outcome to send back. */
export async function answerPermissionRequest(
  params: Record<string, unknown>,
  translator: SessionUpdateTranslator,
  ask: AskBroker,
): Promise<Record<string, unknown>> {
  const options = permissionOptions(params.options);
  const toolCall = asRecord(params.toolCall);
  const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined;
  const known = toolCallId ? translator.toolCall(toolCallId) : undefined;
  const toolName = typeof toolCall.title === "string" && toolCall.title ? toolCall.title : known?.name ?? "tool";
  // A question (AskUserQuestion) offers its answers as the permission
  // options; the person's pick selects the option carrying that label. One
  // ACP reply names one option, so only the first question with a single pick
  // can be carried — the person is asked just that, never questions whose
  // answers would be dropped. A pick with no matching option skips the
  // question, which Kimi treats as "dismissed".
  if (isQuestion(toolName, options)) {
    const asked = askUserQuestions(toolCall.rawInput ?? known?.rawInput)?.[0];
    if (!asked) return selected(options, "reject_once");
    const questions = [{ id: asked.id, text: asked.text, options: asked.options }];
    let answer: PermissionAnswer;
    try {
      answer = await ask({ kind: "question", toolName, input: toolCall.rawInput ?? known?.rawInput ?? {}, ...(toolCallId ? { toolUseId: toolCallId } : {}), questions });
    } catch {
      answer = { behavior: "deny" };
    }
    const pick = answer.behavior === "allow" ? answer.answers?.[questions[0].id]?.[0] : undefined;
    const option = pick === undefined ? undefined : options.find((candidate) => candidate.name?.trim() === pick.trim());
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : selected(options, "reject_once");
  }
  let answer: PermissionAnswer;
  try {
    answer = await ask(permissionQuestion(toolName, toolCall, known, toolCallId));
  } catch {
    answer = { behavior: "deny" };
  }
  return selected(options, answer.behavior === "allow" ? "allow_once" : "reject_once");
}

/** Kimi's AskUserQuestion input mirrors Claude's: `questions[{question, options[{label, description}], multiSelect}]`. */
export function askUserQuestions(input: unknown): PermissionQuestionItem[] | undefined {
  const raw = asRecord(input).questions;
  if (!Array.isArray(raw)) return undefined;
  const questions = raw.flatMap((item) => {
    const question = asRecord(item);
    const text = typeof question.question === "string" ? question.question.trim() : "";
    if (!text) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((option) => {
      const label = asRecord(option).label;
      const description = asRecord(option).description;
      return typeof label === "string" && label.trim()
        ? [{ label: label.trim(), ...(typeof description === "string" && description.trim() ? { description: description.trim() } : {}) }]
        : [];
    });
    return [{ id: questionId(text), text, options, ...(question.multiSelect === true ? { multiSelect: true } : {}) }];
  });
  return questions.length ? questions : undefined;
}

function permissionQuestion(
  toolName: string,
  toolCall: Record<string, unknown>,
  known: KnownToolCall | undefined,
  toolUseId: string | undefined,
): PermissionQuestion {
  const reasonText = contentText(toolCall.content);
  const rawInput = toolCall.rawInput ?? known?.rawInput;
  const locations = toolCall.locations ?? known?.locations;
  const input = rawInput !== undefined
    ? rawInput
    : { ...(locations ? { locations } : {}), ...(reasonText ? { description: reasonText } : {}) };
  return {
    kind: questionKind(typeof toolCall.kind === "string" ? toolCall.kind : known?.kind, toolName),
    toolName,
    input,
    ...(toolUseId ? { toolUseId } : {}),
    ...(reasonText ? { reason: reasonText } : {}),
  };
}

const COMMAND_TOOLS = new Set(["Bash", "Shell", "Terminal"]);
const FILE_TOOLS = new Set(["Write", "Edit", "WriteFile", "StrReplaceFile", "MultiEdit"]);

export function questionKind(acpKind: string | undefined, toolName: string): PermissionQuestionKind {
  if (acpKind === "execute" || COMMAND_TOOLS.has(toolName)) return "command";
  if (acpKind === "edit" || acpKind === "delete" || acpKind === "move" || FILE_TOOLS.has(toolName)) return "file_change";
  return "tool";
}

interface PermissionOption {
  optionId: string;
  kind: string;
  /** The label Kimi shows for the option; a question's answers carry theirs here. */
  name?: string;
}

function permissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    const record = asRecord(option);
    return typeof record.optionId === "string" && typeof record.kind === "string"
      ? [{ optionId: record.optionId, kind: record.kind, ...(typeof record.name === "string" ? { name: record.name } : {}) }]
      : [];
  });
}

function isQuestion(toolName: string, options: PermissionOption[]): boolean {
  return toolName === "AskUserQuestion" || options.some((option) => /^q\d+_/.test(option.optionId));
}

/** The first option of the wanted one-shot kind; cancelling when there is none. */
function selected(options: PermissionOption[], kind: "allow_once" | "reject_once"): Record<string, unknown> {
  const option = options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}

/** JSON-RPC over the child's stdio: our requests, its requests, its notifications. */
class AcpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private closedError: Error | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onRequest: (message: JsonRpcMessage) => Promise<unknown>,
    private readonly onNotification: (message: JsonRpcMessage) => void,
  ) {
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.receive(line));
    child.stdin.on("error", () => {});
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(error: Error): void {
    this.closedError ??= error;
    for (const { reject } of this.pending.values()) reject(this.closedError);
    this.pending.clear();
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.method === undefined) return this.settle(message);
    if (message.id === undefined || message.id === null) return this.onNotification(message);
    const id = message.id;
    this.onRequest(message).then(
      (result) => this.send({ jsonrpc: "2.0", id, result }),
      (error: unknown) => this.send({ jsonrpc: "2.0", id, error: rpcError(error) }),
    );
  }

  private settle(message: JsonRpcMessage): void {
    const waiter = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!waiter) return;
    this.pending.delete(message.id as number);
    if (message.error) waiter.reject(new Error(message.error.message ?? "Kimi returned an error"));
    else waiter.resolve(message.result);
  }
}

class MethodNotFound extends Error {}

function rpcError(error: unknown): Record<string, unknown> {
  if (error instanceof MethodNotFound) return { code: -32601, message: error.message };
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}

/** Runs one prompt; resolves to the process exit code. */
export async function runKimiAcp(options: KimiAcpOptions, io: KimiAcpIo): Promise<number> {
  const writer = new StreamJsonWriter(io.stdout);
  const translator = new SessionUpdateTranslator(writer);
  // A question still open when the prompt ends hangs up, so the broker
  // withdraws its prompt and no open socket keeps this process alive.
  const asks = new AbortController();
  const ask: AskBroker = (question) => io.ask(question, asks.signal);
  const child = spawn(options.kimiCommand, ["acp"], {
    cwd: options.cwd,
    env: runtimeEnv(io.env ?? process.env),
    stdio: ["pipe", "pipe", "pipe"],
    // A `.cmd` shim on Windows only starts through a shell.
    shell: process.platform === "win32",
  });
  child.stderr.on("data", (chunk: Buffer) => io.stderr.write(chunk.toString("utf8")));
  const connection = new AcpConnection(
    child,
    async (message) => {
      if (message.method === "session/request_permission") {
        return await answerPermissionRequest(message.params ?? {}, translator, ask);
      }
      throw new MethodNotFound(`Method not found: ${String(message.method)}`);
    },
    (message) => {
      if (message.method === "session/update") translator.apply(asRecord(message.params?.update));
    },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      connection.close(new Error(`could not start ${options.kimiCommand}: ${error.message}`));
      resolve();
    });
    child.once("close", (code, signal) => {
      connection.close(new Error(`kimi acp exited (${signal ?? `code ${code}`}) before the prompt finished`));
      resolve();
    });
  });
  const stop = stopper(child, exited);
  const onAbort = (): void => {
    connection.close(new Error("The run was cancelled."));
    stop();
  };
  if (io.signal?.aborted) onAbort();
  io.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const { sessionId, stopReason } = await runPrompt(connection, options, writer);
    writer.flush();
    if (stopReason !== "end_turn") {
      io.stderr.write(`error: failed to run prompt: Kimi stopped the turn (${stopReason}).\n`);
      return 1;
    }
    writer.resumeHint(sessionId);
    return 0;
  } catch (error) {
    writer.flush();
    io.stderr.write(`error: failed to run prompt: ${error instanceof Error ? error.message : String(error)}\n`);
    return io.signal?.aborted ? 130 : 1;
  } finally {
    io.signal?.removeEventListener("abort", onAbort);
    asks.abort();
    child.stdin.end();
    stop();
    await exited;
  }
}

async function runPrompt(
  connection: AcpConnection,
  options: KimiAcpOptions,
  writer: StreamJsonWriter,
): Promise<{ sessionId: string; stopReason: string }> {
  const initialized = asRecord(await connection.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    // Kimi runs its own tools; the adapter offers no file system or terminal.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  }));
  const version = asRecord(initialized.agentInfo).version;
  writer.version(typeof version === "string" ? version : "unknown");
  const session = asRecord(await connection.request("session/new", { cwd: options.cwd, mcpServers: [] }));
  const sessionId = session.sessionId;
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Kimi did not open a session");
  await connection.request("session/set_mode", { sessionId, modeId: ASK_WHEN_NEEDED_MODE });
  if (options.model) {
    await connection.request("session/set_config_option", { sessionId, configId: "model", value: options.model });
  }
  const result = asRecord(await connection.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: options.prompt }],
  }));
  return { sessionId, stopReason: typeof result.stopReason === "string" ? result.stopReason : "unknown" };
}

/** Ends the child once: SIGTERM, then SIGKILL after a grace period. */
function stopper(child: ChildProcessWithoutNullStreams, exited: Promise<void>): () => void {
  let stopping = false;
  return () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    timer.unref();
    void exited.then(() => clearTimeout(timer));
  };
}

function contentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join("\n");
  const record = asRecord(content);
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (record.type === "content") return contentText(record.content);
  return "";
}

function argumentsText(rawInput: unknown, content: unknown): string {
  if (rawInput !== undefined) return typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput) ?? "";
  return contentText(content);
}

function outputText(rawOutput: unknown, content: unknown): string {
  if (rawOutput !== undefined) return typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput) ?? String(rawOutput);
  return contentText(content);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseArgs(argv: string[]): KimiAcpOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`Unexpected argument: ${flag}`);
    values.set(flag.slice(2), value);
  }
  const prompt = values.get("prompt");
  if (prompt === undefined) throw new Error("--prompt is required");
  return {
    kimiCommand: values.get("kimi") ?? "kimi",
    cwd: values.get("cwd") ?? process.cwd(),
    ...(values.get("model") ? { model: values.get("model") } : {}),
    prompt,
  };
}

async function main(): Promise<void> {
  let options: KimiAcpOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`relay kimi adapter: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort("SIGTERM"));
  process.once("SIGINT", () => abort.abort("SIGINT"));
  process.stdout.on("error", () => {});
  const code = await runKimiAcp(options, {
    stdout: process.stdout,
    stderr: process.stderr,
    ask: (question, signal) => askBroker(question, process.env, signal),
    signal: abort.signal,
  });
  process.exitCode = code;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
