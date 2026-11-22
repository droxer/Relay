// The broker's half of live messages: a person's message handed to a running
// runtime without stopping it. The run's adapter keeps one listening
// connection on the permission broker's private socket (see
// permission-adapters/protocol.ts `listenForLiveMessages`); the daemon writes
// each message there and waits for the adapter to say how its runtime took it.
//
// A message is delivered at most once per id: a redelivered `run.steer` gets
// the first answer again instead of a second copy in the runtime.
import type { Socket } from "node:net";
import type { LiveMessageDelivery } from "relay-core";

/** How long an adapter has to hand a message to its runtime before the daemon gives up on it. */
export const LIVE_MESSAGE_ACK_TIMEOUT_MS = 30_000;
/** Answers kept for redelivered commands; older ids are forgotten first. */
const REMEMBERED_ANSWERS = 64;
const DELIVERIES: ReadonlySet<string> = new Set<LiveMessageDelivery>(["steer", "follow-up", "interrupt"]);

export type LiveMessageOutcome =
  | { outcome: "delivered"; delivery: LiveMessageDelivery }
  | { outcome: "unavailable" | "failed"; reason: string };

interface Pending {
  promise: Promise<LiveMessageOutcome>;
  settle(outcome: LiveMessageOutcome): void;
}

export class LiveMessageChannel {
  private listener: Socket | undefined;
  private buffer = "";
  private closed = false;
  private readonly pending = new Map<string, Pending>();
  private readonly answered = new Map<string, LiveMessageOutcome>();

  constructor(private readonly ackTimeoutMs = LIVE_MESSAGE_ACK_TIMEOUT_MS) {}

  /** Whether an adapter is listening right now. */
  get listening(): boolean {
    return Boolean(this.listener && !this.listener.destroyed);
  }

  /**
   * Takes over a broker connection whose first line asked to listen. `rest`
   * is whatever arrived after that line. A newer listener replaces an older one.
   */
  attach(socket: Socket, rest: string): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.listener?.destroy();
    this.listener = socket;
    this.buffer = "";
    socket.on("data", (chunk: string | Buffer) => this.read(socket, String(chunk)));
    socket.on("close", () => {
      if (this.listener !== socket) return;
      this.listener = undefined;
      this.failPending({ outcome: "failed", reason: "The runtime stopped listening before it took the message." });
    });
    if (rest) this.read(socket, rest);
  }

  /** Hands one message to the runtime, once per id. */
  deliver(id: string, text: string): Promise<LiveMessageOutcome> {
    const known = this.answered.get(id);
    if (known) return Promise.resolve(known);
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight.promise;
    const listener = this.listener;
    if (this.closed || !listener || listener.destroyed) {
      return Promise.resolve({ outcome: "unavailable", reason: "This run cannot take a message while it works." });
    }
    let settle!: (outcome: LiveMessageOutcome) => void;
    const promise = new Promise<LiveMessageOutcome>((resolve) => { settle = resolve; });
    const timer = setTimeout(
      () => this.finish(id, { outcome: "failed", reason: "The runtime did not take the message in time." }),
      this.ackTimeoutMs,
    );
    timer.unref?.();
    this.pending.set(id, {
      promise,
      settle: (outcome) => {
        clearTimeout(timer);
        settle(outcome);
      },
    });
    listener.write(`${JSON.stringify({ id, text })}\n`);
    return promise;
  }

  /** Ends the channel with its run: every open message fails and later ones are unavailable. */
  close(): void {
    this.closed = true;
    this.failPending({ outcome: "failed", reason: "The run ended before the runtime took the message." });
    this.listener?.destroy();
    this.listener = undefined;
  }

  private read(socket: Socket, chunk: string): void {
    if (socket !== this.listener) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const reply = parseReply(line);
      if (reply) this.finish(reply.id, reply.outcome);
    }
  }

  private finish(id: string, outcome: LiveMessageOutcome): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.remember(id, outcome);
    pending.settle(outcome);
  }

  private failPending(outcome: LiveMessageOutcome): void {
    for (const id of [...this.pending.keys()]) this.finish(id, outcome);
  }

  private remember(id: string, outcome: LiveMessageOutcome): void {
    this.answered.set(id, outcome);
    if (this.answered.size <= REMEMBERED_ANSWERS) return;
    const oldest = this.answered.keys().next().value;
    if (oldest !== undefined) this.answered.delete(oldest);
  }
}

function parseReply(line: string): { id: string; outcome: LiveMessageOutcome } | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string" || !parsed.id) return undefined;
  if (typeof parsed.delivery === "string" && DELIVERIES.has(parsed.delivery)) {
    return { id: parsed.id, outcome: { outcome: "delivered", delivery: parsed.delivery as LiveMessageDelivery } };
  }
  const reason = typeof parsed.error === "string" && parsed.error ? parsed.error : "The runtime refused the message.";
  return { id: parsed.id, outcome: { outcome: "failed", reason } };
}

/** Whether a broker connection's first line asks to listen for live messages. */
export function isListenRequest(parsed: unknown): boolean {
  return Boolean(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).kind === "listen");
}
