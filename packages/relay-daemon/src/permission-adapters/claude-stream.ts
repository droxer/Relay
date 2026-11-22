// Claude launcher for live messages. `claude -p` reads its prompt once, so a
// run that can take a person's message mid-run starts Claude with
// `--input-format stream-json` and keeps its stdin open: the prompt goes in
// as the first user message, each live message as another, and stdin closes
// once every message has its `result`, which is when plain `claude -p` would
// have exited. Claude queues a message written mid-turn and answers it as the
// next turn of the same session (verified on Claude Code 2.1.323), so the
// delivery is `follow-up` and Claude keeps its context.
//
// Stdout passes through byte for byte: renderers, token usage, and resume
// read exactly what plain `claude -p --output-format stream-json` prints.
// Usage: node claude-stream.js (--prompt <text> | --input-file <path>) -- <claude argv...>
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { nativeCommand } from "../native-command.js";
import { listenForLiveMessages, runtimeEnv, type LiveMessageHandler, type LiveMessageListener } from "./protocol.js";

export interface ClaudeStreamOptions {
  /** Stream-json user message lines to write first: the prompt, or a prepared image message. */
  initialMessages: string[];
  /** Claude's argv, `--input-format stream-json` included. */
  argv: string[];
}

export interface ClaudeStreamIo {
  stdout: { write(chunk: Buffer | string): unknown };
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  listen?: (handler: LiveMessageHandler) => LiveMessageListener | undefined;
}

const KILL_GRACE_MS = 2_000;

export function parseClaudeStreamArgs(argv: string[], readFile: (path: string) => string = (path) => readFileSync(path, "utf8")): ClaudeStreamOptions {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("Claude's argv is required after --.");
  const flags = argv.slice(0, separator);
  const claudeArgv = argv.slice(separator + 1);
  if (flags.length !== 2) throw new Error("Pass exactly one of --prompt <text> or --input-file <path>.");
  const [flag, value] = flags as [string, string];
  if (flag === "--prompt") {
    if (!value) throw new Error("--prompt needs text.");
    return { initialMessages: [userMessage(value)], argv: claudeArgv };
  }
  if (flag === "--input-file") {
    const lines = readFile(value).split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) throw new Error("--input-file holds no message.");
    return { initialMessages: lines, argv: claudeArgv };
  }
  throw new Error(`Unknown option: ${flag}`);
}

/** One stream-json user message line. */
export function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

/** Runs Claude until every message it was given has a result; resolves its exit code. */
export async function runClaudeStream(options: ClaudeStreamOptions, io: ClaudeStreamIo): Promise<number> {
  const env = io.env ?? process.env;
  const [command, ...args] = options.argv;
  if (!command) throw new Error("Claude's argv is empty.");
  // The broker's address stays with this launcher; Claude's tools never see it.
  const invocation = nativeCommand(command, args, runtimeEnv(env));
  const child = spawn(invocation.command, invocation.args, {
    env: runtimeEnv(env),
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + signalNumber(signal) : 1)));
  });

  let awaiting = 0;
  let closing = false;
  const send = (line: string): void => {
    awaiting += 1;
    child.stdin.write(`${line}\n`);
  };
  const finishInput = (): void => {
    if (closing) return;
    closing = true;
    child.stdin.end();
  };
  child.stdout.on("data", (chunk: Buffer) => io.stdout.write(chunk));
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (!isResult(line)) return;
    awaiting -= 1;
    // Every message has its answer: end input so Claude exits as `-p` would.
    if (awaiting <= 0) finishInput();
  });

  for (const line of options.initialMessages) send(line);
  const listener = (io.listen ?? ((handler) => listenForLiveMessages(handler, env)))(async (message) => {
    if (closing) throw new Error("Claude has finished its turn and cannot take the message.");
    send(userMessage(message.text));
    return "follow-up";
  });
  const stop = (): void => {
    finishInput();
    child.kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, KILL_GRACE_MS).unref();
  };
  io.signal?.addEventListener("abort", stop, { once: true });
  try {
    return await exited;
  } finally {
    io.signal?.removeEventListener("abort", stop);
    listener?.close();
  }
}

function isResult(line: string): boolean {
  if (!line.includes('"result"')) return false;
  try {
    return (JSON.parse(line) as { type?: unknown }).type === "result";
  } catch {
    return false;
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 2 : signal === "SIGKILL" ? 9 : 15;
}

async function main(): Promise<void> {
  let options: ClaudeStreamOptions;
  try {
    options = parseClaudeStreamArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`relay claude launcher: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort("SIGTERM"));
  process.once("SIGINT", () => abort.abort("SIGINT"));
  process.stdout.on("error", () => {});
  process.exitCode = await runClaudeStream(options, { stdout: process.stdout, signal: abort.signal });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
