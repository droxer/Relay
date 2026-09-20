import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outboxes = new WeakMap<typeof fetch, TerminalOutbox>();
const terminalTypes = new Set(["run.completed", "run.failed", "run.cancelled"]);
const outputTypes = new Set(["run.output", "run.output.batch", "run.collaboration"]);
const durable = (event: Record<string, unknown>) => terminalTypes.has(String(event.type)) || outputTypes.has(String(event.type));
const owner = (event: Record<string, unknown>) => JSON.stringify([event.commandId, event.leaseId ?? null]);
function sequence(event: Record<string, unknown>): number {
  if (terminalTypes.has(String(event.type))) return Infinity;
  if (event.type === "run.output.batch") return Number((event.entries as Array<{ sequence: number }>)[0]?.sequence ?? 0);
  return Number(event.sequence ?? 0);
}
export function persistTerminalEvent(send: typeof fetch, body: unknown): void {
  const event = body as Record<string, unknown> | null;
  if (event && durable(event) && typeof event.commandId === "string") outboxes.get(send)?.retain(event);
}

interface TerminalRecord { key: string; event: Record<string, unknown> }

/** Private durable output and terminal evidence, outside agent workspaces. */
export class TerminalOutbox {
  private offset = 0;
  private readonly sizes = new Map<string, number>();
  private outputBytes = 0;
  private readonly order = new Map<string, { owner: string; sequence: number }>();
  constructor(private readonly directory: string, private readonly onTerminal?: (commandId: string) => void,
    private readonly maxOutputBytes = 64 * 1024 * 1024) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const record of this.pending()) {
      this.order.set(record.key, { owner: owner(record.event), sequence: sequence(record.event) });
      if (outputTypes.has(String(record.event.type))) {
        const bytes = statSync(join(directory, `${record.key}.json`)).size;
        this.sizes.set(record.key, bytes);
        this.outputBytes += bytes;
      }
    }
  }

  pending(): TerminalRecord[] {
    return readdirSync(this.directory).filter((name) => name.endsWith(".json")).map((name) => ({
      key: name.slice(0, -5),
      event: JSON.parse(readFileSync(join(this.directory, name), "utf8")) as Record<string, unknown>,
    })).sort((a, b) => owner(a.event).localeCompare(owner(b.event)) || sequence(a.event) - sequence(b.event));
  }

  retain(event: Record<string, unknown>): TerminalRecord {
    const output = outputTypes.has(String(event.type));
    const identity = [event.commandId, event.leaseId ?? null, ...(output ? [event.type, sequence(event)] : [])];
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const path = join(this.directory, `${key}.json`);
    if (!existsSync(path)) {
      const data = JSON.stringify(event);
      const bytes = Buffer.byteLength(data);
      if (output && this.outputBytes + bytes > this.maxOutputBytes) throw new Error("Durable output storage limit exceeded.");
      const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      const directoryFd = openSync(this.directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      if (output) { this.sizes.set(key, bytes); this.outputBytes += bytes; }
    }
    this.order.set(key, { owner: owner(event), sequence: sequence(event) });
    if (terminalTypes.has(String(event.type))) this.onTerminal?.(String(event.commandId));
    return { key, event: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
  }

  private acknowledge(key: string): void {
    rmSync(join(this.directory, `${key}.json`), { force: true });
    this.outputBytes -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
    this.order.delete(key);
  }

  wrapFetch(send: typeof fetch): typeof fetch {
    const wrapped: typeof fetch = async (input, init) => {
      let record: TerminalRecord | undefined;
      if (init?.method === "POST" && typeof init.body === "string") {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (durable(body) && typeof body.commandId === "string") {
          record = this.retain(body);
          // Live delivery must not jump ahead of durable output left by a
          // disconnected producer. The replay worker will clear predecessors.
          if (outputTypes.has(String(record.event.type)) && [...this.order.values()].some(other => other.owner === owner(record!.event)
            && other.sequence < sequence(record!.event))) {
            return new Response("Earlier output is awaiting delivery.", { status: 503 });
          }
          init = { ...init, body: JSON.stringify(record.event) };
        }
      }
      const response = await send(input, init);
      if (record && response.ok) this.acknowledge(record.key);
      return response;
    };
    outboxes.set(wrapped, this);
    return wrapped;
  }

  async replay(send: typeof fetch, eventUrl: string, token: string, signal?: AbortSignal): Promise<void> {
    const groups = new Map<string, TerminalRecord[]>();
    for (const record of this.pending()) {
      const key = owner(record.event);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(record);
    }
    const owners = [...groups.keys()];
    const start = this.offset % Math.max(1, owners.length);
    this.offset = start + 1;
    let attempts = 0;
    for (const key of [...owners.slice(start), ...owners.slice(0, start)]) {
      let outputBlocked = false;
      for (const record of groups.get(key)!) {
        if (signal?.aborted || attempts >= 50) return;
        if (outputBlocked && outputTypes.has(String(record.event.type))) continue;
        if (!existsSync(join(this.directory, `${record.key}.json`))) continue;
        attempts++;
        try {
          const event = outputTypes.has(String(record.event.type)) ? { ...record.event, replayed: true } : record.event;
          const response = await send(eventUrl, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(event), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
          });
          await response.body?.cancel();
          if (!response.ok) { outputBlocked = true; continue; }
          this.acknowledge(record.key);
        } catch {
          // Output stays ordered; terminal evidence must still release the run.
          outputBlocked = true;
        }
      }
    }
  }
}
