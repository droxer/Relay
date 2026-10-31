// Agent Client Protocol plumbing shared by the runtime ACP adapters (Kimi,
// OpenCode): JSON-RPC over the child's stdio, child shutdown, and the
// permission option helpers. Nothing here knows a runtime's tool names.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}


export interface PermissionOption {
  optionId: string;
  kind: string;
  /** The label Kimi shows for the option; a question's answers carry theirs here. */
  name?: string;
}


export function permissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    const record = asRecord(option);
    return typeof record.optionId === "string" && typeof record.kind === "string"
      ? [{ optionId: record.optionId, kind: record.kind, ...(typeof record.name === "string" ? { name: record.name } : {}) }]
      : [];
  });
}


/** The first option of the wanted one-shot kind; cancelling when there is none. */
export function selected(options: PermissionOption[], kind: "allow_once" | "reject_once"): Record<string, unknown> {
  const option = options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}


/** JSON-RPC over the child's stdio: our requests, its requests, its notifications. */
export class AcpConnection {
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
    if (message.error) waiter.reject(new Error(message.error.message ?? "the ACP agent returned an error"));
    else waiter.resolve(message.result);
  }
}

export class MethodNotFound extends Error {}

export function rpcError(error: unknown): Record<string, unknown> {
  if (error instanceof MethodNotFound) return { code: -32601, message: error.message };
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}


/** Ends the child once: SIGTERM, then SIGKILL after a grace period. */
/** How long a child gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

export function stopper(child: ChildProcessWithoutNullStreams, exited: Promise<void>): () => void {
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

export function contentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join("\n");
  const record = asRecord(content);
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (record.type === "content") return contentText(record.content);
  return "";
}


export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}


export interface AcpChildOptions {
  /** Names the runtime in error messages, e.g. "kimi acp". */
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stderr: { write(text: string): unknown };
  signal?: AbortSignal;
  onRequest: (message: JsonRpcMessage) => Promise<unknown>;
  onNotification: (message: JsonRpcMessage) => void;
}

/**
 * Starts an ACP child, runs `body` against its connection, then stops and
 * reaps it. An abort closes the connection and stops the child at once.
 */
export async function withAcpChild<T>(options: AcpChildOptions, body: (connection: AcpConnection) => Promise<T>): Promise<T> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    // A `.cmd` shim on Windows only starts through a shell.
    shell: process.platform === "win32",
  });
  child.stderr.on("data", (chunk: Buffer) => options.stderr.write(chunk.toString("utf8")));
  const connection = new AcpConnection(child, options.onRequest, options.onNotification);
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      connection.close(new Error(`could not start ${options.command}: ${error.message}`));
      resolve();
    });
    child.once("close", (code, signal) => {
      connection.close(new Error(`${options.label} exited (${signal ?? `code ${code}`}) before the prompt finished`));
      resolve();
    });
  });
  const stop = stopper(child, exited);
  const onAbort = (): void => {
    connection.close(new Error("The run was cancelled."));
    stop();
  };
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await body(connection);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    child.stdin.end();
    stop();
    await exited;
  }
}
