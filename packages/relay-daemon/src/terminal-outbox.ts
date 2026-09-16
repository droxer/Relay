import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outboxes = new WeakMap<typeof fetch, TerminalOutbox>();

export function persistTerminalEvent(send: typeof fetch, body: unknown): void {
  const event = body as Record<string, unknown> | null;
  if (event && ["run.completed", "run.failed", "run.cancelled"].includes(String(event.type)) && typeof event.commandId === "string") {
    outboxes.get(send)?.retain(event);
  }
}

interface TerminalRecord { key: string; event: Record<string, unknown> }

/** Private, durable terminal evidence; never mounted into an agent workspace. */
export class TerminalOutbox {
  private offset = 0;
  constructor(private readonly directory: string, private readonly onTerminal?: (commandId: string) => void) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  pending(): TerminalRecord[] {
    return readdirSync(this.directory).filter((name) => name.endsWith(".json")).sort().map((name) => ({
      key: name.slice(0, -5),
      event: JSON.parse(readFileSync(join(this.directory, name), "utf8")) as Record<string, unknown>,
    }));
  }

  retain(event: Record<string, unknown>): TerminalRecord {
    const key = createHash("sha256").update(JSON.stringify([event.commandId, event.leaseId ?? null])).digest("hex");
    const path = join(this.directory, `${key}.json`);
    if (!existsSync(path)) {
      const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(event)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      const directoryFd = openSync(this.directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
    this.onTerminal?.(String(event.commandId));
    return { key, event: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
  }

  wrapFetch(send: typeof fetch): typeof fetch {
    const wrapped: typeof fetch = async (input, init) => {
      let record: TerminalRecord | undefined;
      if (init?.method === "POST" && typeof init.body === "string") {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (["run.completed", "run.failed", "run.cancelled"].includes(String(body.type)) && typeof body.commandId === "string") {
          record = this.retain(body);
          init = { ...init, body: JSON.stringify(record.event) };
        }
      }
      const response = await send(input, init);
      if (record && response.ok) rmSync(join(this.directory, `${record.key}.json`), { force: true });
      return response;
    };
    outboxes.set(wrapped, this);
    return wrapped;
  }

  async replay(send: typeof fetch, eventUrl: string, token: string, signal?: AbortSignal): Promise<void> {
    const records = this.pending();
    const start = this.offset % Math.max(1, records.length);
    const batch = [...records.slice(start), ...records.slice(0, start)].slice(0, 50);
    this.offset = start + batch.length;
    for (const record of batch) {
      if (signal?.aborted) return;
      try {
        const response = await send(eventUrl, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(record.event), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
        });
        if (response.ok) rmSync(join(this.directory, `${record.key}.json`), { force: true });
        await response.body?.cancel();
      } catch { return; } // Keep durable evidence for the next heartbeat/restart.
    }
  }
}
