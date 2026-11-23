// OpenCode adapter: runs one prompt through `opencode acp` (Agent Client
// Protocol, JSON-RPC over stdio) so OpenCode's permission requests reach a
// person, and prints run-format NDJSON. Text events carry `delta: true` so
// renderers append ACP chunks immediately rather than waiting for a whole part.
//
// Verified against opencode 2.2.0. `opencode acp` takes no --cwd: the working
// directory rides `session/new`. An ask arrives as `session/request_permission`
// with `once` (allow_once), `always` (allow_always), and `reject` (reject_once)
// options. The answer is always one-shot: `always` is never selected, because
// the broker grants one approval at a time and keeps no standing rule.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AcpConnection, asRecord, MethodNotFound, withAcpChild, type JsonRpcMessage } from "./acp-connection.js";
import { answerPermissionRequest, RunJsonWriter, SessionUpdateTranslator, type AskBroker } from "./acp-session-updates.js";
import {
  askBroker,
  listenForLiveMessages,
  NATIVE_RUNTIME_STARTUP_TIMEOUT_MS,
  runtimeEnv,
  type LiveMessageHandler,
  type LiveMessageListener,
} from "./protocol.js";

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
  startupTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Starts listening for a person's live messages; defaults to the run's broker. */
  listen?: Listen;
}

/** Starts listening for live messages; undefined when the run has no broker. */
export type Listen = (handler: LiveMessageHandler) => LiveMessageListener | undefined;

/** Runs one prompt; resolves to the process exit code. */
export async function runOpenCodeAcp(options: OpenCodeAcpOptions, io: OpenCodeAcpIo): Promise<number> {
  if (io.signal?.aborted) return 130;
  const writer = new RunJsonWriter(io.stdout);
  const translator = new SessionUpdateTranslator(writer);
  // A question still open when the prompt ends hangs up, so the broker
  // withdraws its prompt and no open socket keeps this process alive.
  const asks = new AbortController();
  const ask: AskBroker = (question) => io.ask(question, asks.signal);
  const startup = new AbortController();
  const timer = setTimeout(() => startup.abort(new Error("Starting OpenCode timed out before the prompt began.")), io.startupTimeoutMs ?? NATIVE_RUNTIME_STARTUP_TIMEOUT_MS);
  const signal = io.signal ? AbortSignal.any([io.signal, startup.signal]) : startup.signal;
  try {
    return await withAcpChild(
      {
        label: "opencode acp",
        command: options.opencodeCommand ?? "opencode",
        args: ["acp"],
        cwd: options.cwd,
        env: runtimeEnv(io.env ?? process.env),
        stderr: io.stderr,
        signal,
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
          const stopReason = await runPrompt(
            connection,
            options,
            io.listen ?? ((handler) => listenForLiveMessages(handler, io.env ?? process.env)),
            () => {
              clearTimeout(timer);
              writer.started();
            },
          );
          if (stopReason !== "end_turn") {
            reportFailure(io, writer, `OpenCode stopped the turn (${stopReason}).`);
            return 1;
          }
          return 0;
        } catch (error) {
          reportFailure(io, writer, error instanceof Error ? error.message : String(error));
          return io.signal?.aborted ? 130 : 1;
        }
      },
    );
  } finally {
    clearTimeout(timer);
    asks.abort();
  }
}

function reportFailure(io: OpenCodeAcpIo, writer: RunJsonWriter, message: string): void {
  writer.error(message);
  io.stderr.write(`error: failed to run prompt: ${message}\n`);
}

async function runPrompt(
  connection: AcpConnection,
  options: OpenCodeAcpOptions,
  listen: Listen,
  onReady: () => void,
): Promise<string> {
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
  // ACP has no steer. A person's message ends the turn in flight
  // (`session/cancel`) and becomes the next prompt of the same session, so
  // OpenCode keeps everything it did; the run ends with the last turn's reason.
  const queued: string[] = [];
  let inFlight = false;
  let finished = false;
  const listener = listen(async (message) => {
    if (finished) throw new Error("OpenCode has no turn in progress to take the message.");
    queued.push(message.text);
    if (inFlight) connection.notify("session/cancel", { sessionId });
    return "interrupt";
  });
  try {
    onReady();
    let text = options.prompt;
    for (;;) {
      inFlight = true;
      const result = asRecord(await connection.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }));
      inFlight = false;
      if (queued.length === 0) return typeof result.stopReason === "string" ? result.stopReason : "unknown";
      text = queued.splice(0).join("\n\n");
    }
  } finally {
    finished = true;
    listener?.close();
  }
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
