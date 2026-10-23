import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory, syncDirectoryAsync } from "./sync-directory.js";

// Timeout and rate limiting are transient even though they are 4xx.
const permanentlyRejected = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;
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

/**
 * Private durable output and terminal evidence, outside agent workspaces.
 *
 * Terminal events are written synchronously and fsynced before `retain`
 * returns: they are the only evidence a run ended. Streamed output is
 * write-behind — the record is accounted for at once but lands on disk off
 * the event loop, so one run's output never stalls every other run's loop.
 * A crash in that window loses only output the live post was carrying.
 */
export class TerminalOutbox {
  private offset = 0;
  private readonly sizes = new Map<string, number>();
  private outputBytes = 0;
  private readonly order = new Map<string, { owner: string; sequence: number }>();
  /** Output records pending on disk or retained in memory after a write failure. */
  private readonly writes = new Map<string, { event: Record<string, unknown>; done: Promise<boolean> }>();
  /** Every write-behind chain (writes and the removals that follow them). */
  private readonly settling = new Set<Promise<void>>();
  constructor(private readonly directory: string, private readonly onTerminal?: (commandId: string) => void,
    private readonly maxOutputBytes = 64 * 1024 * 1024, private readonly onWriteError?: (error: Error) => void) {
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
    const stored = readdirSync(this.directory).filter((name) => name.endsWith(".json")).map((name) => ({
      key: name.slice(0, -5),
      event: JSON.parse(readFileSync(join(this.directory, name), "utf8")) as Record<string, unknown>,
    }));
    const onDisk = new Set(stored.map((record) => record.key));
    const landing = [...this.writes].filter(([key]) => !onDisk.has(key)).map(([key, { event }]) => ({ key, event }));
    return [...stored, ...landing].sort((a, b) => owner(a.event).localeCompare(owner(b.event)) || sequence(a.event) - sequence(b.event));
  }

  retain(event: Record<string, unknown>): TerminalRecord {
    const output = outputTypes.has(String(event.type));
    const identity = [event.commandId, event.leaseId ?? null, ...(output ? [event.type, sequence(event)] : [])];
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const path = join(this.directory, `${key}.json`);
    // Output is accounted for in memory the moment it is retained, so a
    // record whose write is still in flight is never written twice.
    if (output ? !this.sizes.has(key) : !existsSync(path)) {
      const data = JSON.stringify(event);
      const bytes = Buffer.byteLength(data);
      const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
      if (output) {
        if (this.outputBytes + bytes > this.maxOutputBytes || this.sizes.size >= 4096) throw new Error("Durable output storage limit exceeded.");
        this.sizes.set(key, bytes);
        this.outputBytes += bytes;
        const done = this.writeBehind(temporary, path, data);
        this.writes.set(key, { event, done });
        this.settle(done.then((stored) => {
          // A failed write keeps its in-memory copy for replay. Dropping it
          // would strand the ordering and quota entries for this sequence.
          if (stored && this.writes.get(key)?.done === done) this.writes.delete(key);
        }));
      } else {
        const fd = openSync(temporary, "wx", 0o600);
        try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, path);
        syncDirectory(this.directory);
      }
    }
    this.order.set(key, { owner: owner(event), sequence: sequence(event) });
    // Output identity includes its type and sequence, so the stored record is
    // this event; skip the read-back on the live path. A terminal record keys
    // on the command alone, and the first one stored must win.
    if (output) return { key, event };
    if (terminalTypes.has(String(event.type))) this.onTerminal?.(String(event.commandId));
    return { key, event: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
  }

  private async writeBehind(temporary: string, path: string, data: string): Promise<boolean> {
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      await syncDirectoryAsync(this.directory);
      return true;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      this.onWriteError?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private settle(chain: Promise<void>): void {
    this.settling.add(chain);
    void chain.finally(() => this.settling.delete(chain));
  }

  /** Wait for disk writes and removals; failed writes remain in memory for replay. */
  async flush(): Promise<void> {
    while (this.settling.size > 0) await Promise.allSettled([...this.settling]);
  }

  private acknowledge(key: string): void {
    const path = join(this.directory, `${key}.json`);
    const inFlight = this.writes.get(key);
    // A record acknowledged while its write is still landing is removed
    // once it has, so no delivered output is left behind for replay.
    if (inFlight) {
      this.writes.delete(key);
      this.settle(inFlight.done.then(() => rm(path, { force: true })).catch(() => undefined));
    } else {
      rmSync(path, { force: true });
    }
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
          // A replay worker may finalize the command while this live sender
          // is retrying. Late durable output must remain admissible then.
          const event = outputTypes.has(String(record.event.type))
            ? { ...record.event, replayed: true } : record.event;
          init = { ...init, body: JSON.stringify(event) };
        }
      }
      const response = await send(input, init);
      if (record && (response.ok || permanentlyRejected(response.status))) this.acknowledge(record.key);
      return response;
    };
    outboxes.set(wrapped, this);
    return wrapped;
  }

  async replay(send: typeof fetch, eventUrl: string, token: string, signal?: AbortSignal): Promise<void> {
    await this.flush();
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
        // Failed disk writes are still pending in memory. A live sender may
        // already have acknowledged a snapshot entry while replay awaited I/O.
        if (!this.order.has(record.key)) continue;
        attempts++;
        try {
          const event = outputTypes.has(String(record.event.type)) ? { ...record.event, replayed: true } : record.event;
          const response = await send(eventUrl, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(event), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
          });
          await response.body?.cancel();
          if (!response.ok && !permanentlyRejected(response.status)) { outputBlocked = true; continue; }
          this.acknowledge(record.key);
        } catch {
          // Output stays ordered; terminal evidence must still release the run.
          outputBlocked = true;
        }
      }
    }
  }
}
