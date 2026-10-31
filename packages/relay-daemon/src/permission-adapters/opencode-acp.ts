// OpenCode adapter: runs one prompt through `opencode acp` (Agent Client
// Protocol, JSON-RPC over stdio) so OpenCode's permission requests reach a
// person, and prints the NDJSON `opencode run --format json` prints, so
// OpenCodeStreamRenderer and the run's log parsing need no second format.
//
// Verified against opencode 2.2.0. `opencode acp` takes no --cwd: the working
// directory rides `session/new`. An ask arrives as `session/request_permission`
// with `once` (allow_once), `always` (allow_always), and `reject` (reject_once)
// options. The answer is always one-shot: `always` is never selected, because
// the broker grants one approval at a time and keeps no standing rule.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AcpConnection, asRecord, contentText, MethodNotFound, permissionOptions, selected, withAcpChild, type JsonRpcMessage } from "./acp-connection.js";
import { askBroker, runtimeEnv, type PermissionAnswer, type PermissionQuestion, type PermissionQuestionKind } from "./protocol.js";

/** Asks about one request; `signal` fires once the prompt is over and nobody can act on the answer. */
export type AskBroker = (question: PermissionQuestion, signal?: AbortSignal) => Promise<PermissionAnswer>;

const ACP_PROTOCOL_VERSION = 1;

export interface OpenCodeAcpOptions {
  /** The OpenCode executable; `opencode` on PATH by default. */
  opencodeCommand?: string;
  /** Absolute workspace the session works in. */
  cwd: string;
  /** A `provider/model` id to select; omitted keeps OpenCode's own default. */
  model?: string;
  prompt: string;
}

export interface OpenCodeAcpIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  ask: AskBroker;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

interface ToolState {
  status: "completed" | "error";
  input?: unknown;
  output?: string;
  error?: string;
  title?: string;
}

/** Prints `opencode run --format json` events. Assistant text is buffered until a tool call or the end of the turn. */
export class RunJsonWriter {
  private assistantText = "";

  constructor(private readonly out: { write(text: string): unknown }) {}

  assistantDelta(delta: string): void {
    this.assistantText += delta;
  }

  toolUse(tool: string, state: ToolState): void {
    this.flush();
    this.line({ type: "tool_use", part: { tool, state } });
  }

  error(message: string): void {
    this.flush();
    this.line({ type: "error", error: { message } });
  }

  flush(): void {
    if (this.assistantText.length === 0) return;
    this.line({ type: "text", part: { type: "text", text: this.assistantText } });
    this.assistantText = "";
  }

  private line(event: Record<string, unknown>): void {
    this.out.write(`${JSON.stringify(event)}\n`);
  }
}

interface KnownToolCall {
  name: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  done: boolean;
}

/** Translates `session/update` notifications into run events, and remembers tool calls for their permission requests. */
export class SessionUpdateTranslator {
  private readonly calls = new Map<string, KnownToolCall>();

  constructor(private readonly writer: RunJsonWriter) {}

  toolCall(id: string): KnownToolCall | undefined {
    return this.calls.get(id);
  }

  apply(update: Record<string, unknown>): void {
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = contentText(update.content);
      if (text) this.writer.assistantDelta(text);
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.applyToolCall(update);
    }
    // Thinking, plans, usage, and command lists stay off stdout, as in `opencode run`.
  }

  private applyToolCall(update: Record<string, unknown>): void {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!id) return;
    const known = this.calls.get(id);
    const call: KnownToolCall = known ?? {
      name: typeof update.name === "string" && update.name ? update.name : "tool",
      done: false,
    };
    if (typeof update.title === "string" && update.title) call.title = update.title;
    if (typeof update.kind === "string") call.kind = update.kind;
    if (update.rawInput !== undefined) call.rawInput = update.rawInput;
    this.calls.set(id, call);
    if (call.done) return;
    if (update.status !== "completed" && update.status !== "failed") return;
    call.done = true;
    const output = outputText(update);
    const failed = update.status === "failed";
    // `opencode run` names a failed tool's message `error`, not `output`.
    this.writer.toolUse(call.name, {
      status: failed ? "error" : "completed",
      ...(call.rawInput !== undefined ? { input: call.rawInput } : {}),
      ...(output ? (failed ? { error: output } : { output }) : {}),
      ...(call.title ? { title: call.title } : {}),
    });
  }
}

/** One `session/request_permission` in, the ACP outcome to send back. Never selects an `always` option. */
export async function answerPermissionRequest(
  params: Record<string, unknown>,
  translator: SessionUpdateTranslator,
  ask: AskBroker,
): Promise<Record<string, unknown>> {
  const options = permissionOptions(params.options);
  const toolCall = asRecord(params.toolCall);
  const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined;
  const known = toolCallId ? translator.toolCall(toolCallId) : undefined;
  const toolName = (typeof toolCall.name === "string" && toolCall.name) || known?.name || "tool";
  const title = (typeof toolCall.title === "string" && toolCall.title) || known?.title;
  const acpKind = typeof toolCall.kind === "string" ? toolCall.kind : known?.kind;
  const question: PermissionQuestion = {
    kind: questionKind(acpKind),
    toolName,
    input: toolCall.rawInput ?? known?.rawInput ?? {},
    ...(toolCallId ? { toolUseId: toolCallId } : {}),
    ...(title ? { reason: title } : {}),
  };
  let answer: PermissionAnswer;
  try {
    answer = await ask(question);
  } catch {
    answer = { behavior: "deny" };
  }
  return selected(options, answer.behavior === "allow" ? "allow_once" : "reject_once");
}

/** ACP tool kinds mapped onto the broker's question kinds; anything else is a generic tool. */
export function questionKind(acpKind: string | undefined): PermissionQuestionKind {
  if (acpKind === "execute") return "command";
  if (acpKind === "edit" || acpKind === "delete" || acpKind === "move") return "file_change";
  return "tool";
}

/** Runs one prompt; resolves to the process exit code. */
export async function runOpenCodeAcp(options: OpenCodeAcpOptions, io: OpenCodeAcpIo): Promise<number> {
  const writer = new RunJsonWriter(io.stdout);
  const translator = new SessionUpdateTranslator(writer);
  // A question still open when the prompt ends hangs up, so the broker
  // withdraws its prompt and no open socket keeps this process alive.
  const asks = new AbortController();
  const ask: AskBroker = (question) => io.ask(question, asks.signal);
  try {
    return await withAcpChild(
      {
        label: "opencode acp",
        command: options.opencodeCommand ?? "opencode",
        args: ["acp"],
        cwd: options.cwd,
        env: runtimeEnv(io.env ?? process.env),
        stderr: io.stderr,
        signal: io.signal,
        onRequest: async (message: JsonRpcMessage) => {
          if (message.method === "session/request_permission") {
            return await answerPermissionRequest(message.params ?? {}, translator, ask);
          }
          throw new MethodNotFound(`Method not found: ${String(message.method)}`);
        },
        onNotification: (message: JsonRpcMessage) => {
          if (message.method === "session/update") translator.apply(asRecord(message.params?.update));
        },
      },
      async (connection) => {
        try {
          const stopReason = await runPrompt(connection, options);
          writer.flush();
          if (stopReason !== "end_turn") {
            reportFailure(io, writer, `OpenCode stopped the turn (${stopReason}).`);
            return 1;
          }
          return 0;
        } catch (error) {
          writer.flush();
          reportFailure(io, writer, error instanceof Error ? error.message : String(error));
          return io.signal?.aborted ? 130 : 1;
        }
      },
    );
  } finally {
    asks.abort();
  }
}

function reportFailure(io: OpenCodeAcpIo, writer: RunJsonWriter, message: string): void {
  writer.error(message);
  io.stderr.write(`error: failed to run prompt: ${message}\n`);
}

async function runPrompt(connection: AcpConnection, options: OpenCodeAcpOptions): Promise<string> {
  await connection.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    // OpenCode runs its own tools; the adapter offers no file system or terminal.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  const session = asRecord(await connection.request("session/new", { cwd: options.cwd, mcpServers: [] }));
  const sessionId = session.sessionId;
  if (typeof sessionId !== "string" || !sessionId) throw new Error("OpenCode did not open a session");
  if (options.model) {
    await connection.request("session/set_config_option", { sessionId, configId: "model", value: options.model });
  }
  const result = asRecord(await connection.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: options.prompt }],
  }));
  return typeof result.stopReason === "string" ? result.stopReason : "unknown";
}

function outputText(update: Record<string, unknown>): string {
  if (update.rawOutput !== undefined) {
    return typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput) ?? "";
  }
  return contentText(update.content);
}

export function parseArgs(argv: string[]): OpenCodeAcpOptions {
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
    opencodeCommand: values.get("opencode") ?? "opencode",
    cwd: values.get("cwd") ?? process.cwd(),
    ...(values.get("model") ? { model: values.get("model") } : {}),
    prompt,
  };
}

async function main(): Promise<void> {
  let options: OpenCodeAcpOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`relay opencode adapter: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort("SIGTERM"));
  process.once("SIGINT", () => abort.abort("SIGINT"));
  process.stdout.on("error", () => {});
  const code = await runOpenCodeAcp(options, {
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
