// Per-run permission broker, the runtime-agnostic core of live permission
// prompts. A local, native-policy run asks before using a tool; its runtime
// adapter (permission-adapters/) forwards each normalized question here over a
// private socket, and the broker asks a person through the backend: it posts
// `run.permission_requested`, then polls the request until someone answers.
// Anything that keeps Relay from asking denies the tool use; the run itself
// stays alive either way. A prompt the run stops waiting on — its runtime hung
// up, or the daemon's deadline passed — is withdrawn (`run.permission_withdrawn`)
// so the thread never shows a question nobody is waiting on.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERMISSION_INPUT_LIMIT,
  PERMISSION_OPTIONS_LIMIT,
  PERMISSION_QUESTIONS_LIMIT,
  PERMISSION_TEXT_LIMIT,
  relayApiUrl,
  type AgentName,
  type DaemonNodeEvent,
  type DaemonNodeRunCommand,
  type DaemonNodeSandboxMode,
  type DaemonPermissionDecision,
  type PermissionQuestionItem,
  getAgent,
} from "relay-core";
import { BROKER_FILE_ENV, parseAnswers, type PermissionAnswer, type PermissionQuestion } from "./permission-adapters/protocol.js";

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const POLL_REQUEST_TIMEOUT_MS = 30_000;
/** How long a prompt waits for a person before the daemon withdraws it and
 *  denies the tool: `RELAY_DAEMON_PERMISSION_TIMEOUT_MS`, 0 to wait forever. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 30 * 60_000;
/** A request line larger than this is not a permission question. */
const MAX_REQUEST_BYTES = 1_048_576;
const DENIED_BY_USER = "Denied by the user in Relay.";
const EXPIRED = "The permission request expired.";
const CANNOT_ASK = "Relay could not ask a person for permission";
const HUNG_UP = "The permission prompt disconnected.";

export function permissionTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RELAY_DAEMON_PERMISSION_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_PERMISSION_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_PERMISSION_TIMEOUT_MS;
}

export type PermissionRunScope = Pick<DaemonNodeRunCommand, "id" | "sessionId" | "runId" | "agent" | "leaseId">;

export interface PermissionBrokerOptions {
  fetchFn: typeof fetch;
  backendUrl: string;
  sandboxId: string;
  token: string;
  command: PermissionRunScope;
  /** Delivers one daemon event, retrying transient failures; throws when it cannot. */
  postEvent(event: DaemonNodeEvent, signal: AbortSignal): Promise<void>;
  /** The run's signal: once it fires, every open question is denied. */
  signal?: AbortSignal;
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
  pollIntervalMs?: number;
  /** How long a prompt waits for a person; 0 waits forever. */
  timeoutMs?: number;
  /** Parent of the private socket directory; defaults to the OS temp dir. */
  socketParent?: string;
  /** Override the platform; tests use it to cover the named-pipe path. */
  platform?: NodeJS.Platform;
}

export interface PermissionBroker {
  /** What an adapter needs to reach this broker: the path of its address file. */
  readonly env: { RELAY_PERMISSION_FILE: string };
  readonly socketPath: string;
  /** The 0700 directory holding the socket and the address file. */
  readonly privateDir: string;
  close(): Promise<void>;
}

/** Only a run on a local computer under the native policy asks a person, and
 *  only on a runtime whose registry entry names a permission adapter. */
export function permissionPromptsApply(
  agent: AgentName,
  sandboxMode: DaemonNodeSandboxMode,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getAgent(agent).permissionPrompts.kind === "adapter"
    && sandboxMode === "none"
    && (env.RELAY_LOCAL_PERMISSION_POLICY ?? "native") === "native";
}

export async function startPermissionBroker(options: PermissionBrokerOptions): Promise<PermissionBroker> {
  const secret = randomBytes(32).toString("hex");
  const { socketPath, privateDir } = privatePaths(options);
  const addressFile = join(privateDir, "broker.json");
  const closing = new AbortController();
  const brokerSignal = options.signal ? AbortSignal.any([options.signal, closing.signal]) : closing.signal;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serveConnection(socket, secret, options, brokerSignal);
  });
  try {
    await listen(server, socketPath);
    writeFileSync(addressFile, JSON.stringify({ socket: socketPath, secret }), { mode: 0o600 });
  } catch (error) {
    rmSync(privateDir, { recursive: true, force: true });
    throw error;
  }
  let closed: Promise<void> | undefined;
  return {
    socketPath,
    privateDir,
    env: { [BROKER_FILE_ENV]: addressFile },
    close: () => {
      closed ??= (async () => {
        closing.abort("The run ended before a person answered.");
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        // Open questions answer deny on abort; give them a tick to flush.
        await new Promise((resolve) => setImmediate(resolve));
        for (const socket of sockets) socket.destroy();
        await stopped;
        rmSync(privateDir, { recursive: true, force: true });
      })();
      return closed;
    },
  };
}

/** A 0700 directory only this user can reach, holding the socket (a named pipe on Windows) and the address file. */
function privatePaths(options: PermissionBrokerOptions): { socketPath: string; privateDir: string } {
  const privateDir = mkdtempSync(join(options.socketParent ?? tmpdir(), "relay-perm-"));
  chmodSync(privateDir, 0o700);
  if ((options.platform ?? process.platform) === "win32") {
    return { socketPath: `\\\\.\\pipe\\relay-permission-${randomBytes(12).toString("hex")}`, privateDir };
  }
  return { socketPath: join(privateDir, "broker.sock"), privateDir };
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** One connection carries one question and gets one answer. */
function serveConnection(socket: Socket, secret: string, options: PermissionBrokerOptions, brokerSignal: AbortSignal): void {
  const hungUp = new AbortController();
  const signal = AbortSignal.any([brokerSignal, hungUp.signal]);
  let buffer = "";
  let answered = false;
  const reply = (decision: PermissionAnswer): void => {
    if (answered) return;
    answered = true;
    if (!socket.destroyed) socket.end(`${JSON.stringify(decision)}\n`);
  };
  socket.setEncoding("utf8");
  socket.on("error", () => hungUp.abort(HUNG_UP));
  socket.on("close", () => hungUp.abort(HUNG_UP));
  socket.on("data", (chunk: string) => {
    if (answered) return;
    buffer += chunk;
    if (buffer.length > MAX_REQUEST_BYTES) return reply(deny("The permission request was too large."));
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = parseRequest(buffer.slice(0, newline), secret);
    if (!request) return reply(deny("The permission request was not from this run."));
    void askPerson(request, options, signal).then(reply, (error: unknown) => {
      options.logger?.warn("permission request failed", { ...scopeFields(options.command), error: errorMessage(error) });
      reply(deny(`${CANNOT_ASK}.`));
    });
  });
}

function parseRequest(line: string, secret: string): PermissionQuestion | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || !secretMatches(parsed.secret, secret)) return undefined;
  const questions = parsed.kind === "question" ? parseQuestions(parsed.questions) : undefined;
  return {
    kind: questions ? "question" : isQuestionKind(parsed.kind) && parsed.kind !== "question" ? parsed.kind : "tool",
    toolName: typeof parsed.toolName === "string" ? parsed.toolName : "",
    input: parsed.input ?? {},
    ...(typeof parsed.toolUseId === "string" && parsed.toolUseId ? { toolUseId: parsed.toolUseId } : {}),
    ...(typeof parsed.reason === "string" && parsed.reason ? { reason: parsed.reason } : {}),
    ...(questions ? { questions } : {}),
  };
}

function isQuestionKind(value: unknown): value is PermissionQuestion["kind"] {
  return value === "command" || value === "file_change" || value === "tool" || value === "question";
}

/**
 * The questions a runtime asks, within the backend's bounds; undefined when
 * there are none well-formed, so the prompt falls back to a plain approval.
 */
export function parseQuestions(value: unknown): PermissionQuestionItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = (item: unknown): string => (typeof item === "string" ? item.trim().slice(0, PERMISSION_TEXT_LIMIT) : "");
  const questions: PermissionQuestionItem[] = [];
  for (const raw of value.slice(0, PERMISSION_QUESTIONS_LIMIT)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = text(item.id);
    const question = text(item.text);
    if (!id || !question) continue;
    const options = (Array.isArray(item.options) ? item.options : []).slice(0, PERMISSION_OPTIONS_LIMIT).flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const label = text((option as Record<string, unknown>).label);
      const description = text((option as Record<string, unknown>).description);
      return label ? [{ label, ...(description ? { description } : {}) }] : [];
    });
    questions.push({ id, text: question, options, ...(item.multiSelect === true ? { multiSelect: true } : {}) });
  }
  return questions.length ? questions : undefined;
}

function secretMatches(given: unknown, secret: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Posts the question, then polls until a person answers or Relay cannot ask.
 * `signal` is the connection's: the run ending, the runtime hanging up, or
 * the broker closing. The deadline is the broker's own.
 */
export async function askPerson(
  request: PermissionQuestion,
  options: PermissionBrokerOptions,
  signal: AbortSignal,
): Promise<PermissionAnswer> {
  const requestId = `perm_${randomBytes(12).toString("hex")}`;
  const { command } = options;
  const scope = {
    commandId: command.id,
    ...(command.leaseId ? { leaseId: command.leaseId } : {}),
    sessionId: command.sessionId,
    runId: command.runId,
    agent: command.agent,
  };
  try {
    await options.postEvent({
      type: "run.permission_requested",
      ...scope,
      request: {
        id: requestId,
        toolName: request.toolName,
        ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
        input: cappedInput(withReason(request)),
        ...(request.questions ? { questions: request.questions } : {}),
      },
    }, signal);
  } catch (error) {
    if (signal.aborted) return deny(cannotAsk(signal.reason));
    options.logger?.warn("permission request not delivered", { ...scopeFields(command), requestId, error: errorMessage(error) });
    return deny(`${CANNOT_ASK}: the backend did not accept the request.`);
  }
  const timeoutMs = options.timeoutMs ?? permissionTimeoutMs();
  const deadline = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => deadline.abort(timedOut(timeoutMs)), timeoutMs) : undefined;
  const waiting = AbortSignal.any([signal, deadline.signal]);
  try {
    const answer = await pollDecision(requestId, options, waiting);
    // Nobody is waiting on an answer any more: the run gave up, the runtime
    // hung up, or the deadline passed. Only the run ending leaves nothing
    // open — the backend expires its prompts itself.
    if (answer.behavior === "deny" && waiting.aborted && typeof waiting.reason === "string" && !options.signal?.aborted) {
      await withdraw(requestId, waiting.reason, scope, options);
    }
    return answer;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function timedOut(timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  return minutes >= 1 ? `No one answered within ${minutes} minute${minutes === 1 ? "" : "s"}.` : "No one answered in time.";
}

/** Tell the backend the prompt is moot; a failure here only leaves it to expire with the run. */
async function withdraw(
  requestId: string,
  reason: string,
  scope: Omit<Extract<DaemonNodeEvent, { type: "run.permission_withdrawn" }>, "type" | "requestId" | "reason">,
  options: PermissionBrokerOptions,
): Promise<void> {
  try {
    await options.postEvent(
      { type: "run.permission_withdrawn", ...scope, requestId, reason },
      AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS)]),
    );
  } catch (error) {
    options.logger?.warn("permission request not withdrawn", { ...scopeFields(options.command), requestId, error: errorMessage(error) });
  }
}

async function pollDecision(requestId: string, options: PermissionBrokerOptions, signal: AbortSignal): Promise<PermissionAnswer> {
  const url = new URL(relayApiUrl(
    options.backendUrl,
    `/daemon-nodes/${encodeURIComponent(options.sandboxId)}/permission-requests/${encodeURIComponent(requestId)}`,
  ));
  url.searchParams.set("sessionId", options.command.sessionId);
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (true) {
    if (signal.aborted) return deny(cannotAsk(signal.reason));
    const outcome = await pollOnce(url.toString(), options, signal);
    if (outcome) return outcome;
    try {
      await sleep(interval, signal);
    } catch {
      return deny(cannotAsk(signal.reason));
    }
  }
}

/** A decision when the poll settles the question, undefined to poll again. */
async function pollOnce(url: string, options: PermissionBrokerOptions, signal: AbortSignal): Promise<PermissionAnswer | undefined> {
  let response: Response;
  try {
    response = await options.fetchFn(url, {
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS)]),
    });
  } catch {
    // Network trouble is transient; the person may still answer.
    return signal.aborted ? deny(cannotAsk(signal.reason)) : undefined;
  }
  if (!response.ok) {
    if (permanentlyRejected(response.status)) {
      return deny(`${CANNOT_ASK}: the backend answered ${response.status}.`);
    }
    return undefined;
  }
  let body: Partial<DaemonPermissionDecision>;
  try {
    body = await response.json() as Partial<DaemonPermissionDecision>;
  } catch {
    return undefined;
  }
  switch (body.status) {
    case "allow": {
      const answers = parseAnswers(body.answers);
      return answers ? { behavior: "allow", answers } : { behavior: "allow" };
    }
    case "deny":
      return deny(typeof body.note === "string" && body.note.trim() ? body.note : DENIED_BY_USER);
    case "expired":
      return deny(EXPIRED);
    default:
      return undefined;
  }
}

// Timeout and rate limiting are transient even though they are 4xx.
function permanentlyRejected(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** The backend event has no reason field; the person still sees why it asks. */
function withReason(question: PermissionQuestion): unknown {
  const input = question.input;
  if (!question.reason || !input || typeof input !== "object" || Array.isArray(input) || "reason" in input) return input;
  return { ...input, reason: question.reason };
}

function cappedInput(input: unknown): string {
  const text = JSON.stringify(input) ?? "null";
  return text.length > PERMISSION_INPUT_LIMIT ? `${text.slice(0, PERMISSION_INPUT_LIMIT - 1)}…` : text;
}

function cannotAsk(reason: unknown): string {
  return typeof reason === "string" && reason ? `${CANNOT_ASK}: ${reason}` : `${CANNOT_ASK}.`;
}

function deny(message: string): PermissionAnswer {
  return { behavior: "deny", message };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function scopeFields(command: PermissionRunScope): Record<string, unknown> {
  return { commandId: command.id, sessionId: command.sessionId, runId: command.runId, agent: command.agent };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
