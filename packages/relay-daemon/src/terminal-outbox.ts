import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { open, rename } from 'node:fs/promises';
import { ReportOrder } from './report-order.js';
import { EVENT_REQUEST_TIMEOUT_MS } from './event-request-policy.js';
import { retryAfterMs } from './transport-retry.js';
import { syncDirectory, syncDirectoryAsync } from './sync-directory.js';
import { sendTerminalEvent, terminalEventPayload } from './terminal-event-payload.js';
import { errorBodyDetail, responseErrorDetail } from './http-error-detail.js';

const permanentlyRejected = (status: number) => status >= 400 && status < 500 && ![408, 429].includes(status);
const outboxes = new WeakMap<typeof fetch, TerminalOutbox>();
const terminalTypes = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const outputTypes = new Set(['run.output', 'run.output.batch', 'run.collaboration']);
const durable = (event: Record<string, unknown>) => terminalTypes.has(String(event.type)) || outputTypes.has(String(event.type));
const owner = (event: Record<string, unknown>) => JSON.stringify([event.commandId, event.leaseId ?? null]);
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
function sequence(event: Record<string, unknown>): number {
  if (terminalTypes.has(String(event.type))) return Infinity;
  if (event.type === 'run.output.batch') return Number((event.entries as Array<{ sequence: number }>)[0]?.sequence ?? 0);
  return Number(event.sequence ?? 0);
}
export function persistTerminalEvent(send: typeof fetch, body: unknown): Promise<void> {
  const event = body as Record<string, unknown> | null;
  if (event && durable(event) && typeof event.commandId === 'string') return outboxes.get(send)?.retain(event).durable ?? Promise.resolve();
  return Promise.resolve();
}
export function queuesOutputForReplay(send: typeof fetch, body: unknown): boolean {
  return !!body && outputTypes.has(String((body as Record<string, unknown>).type)) && (outboxes.get(send)?.usesBatching() ?? false);
}
export function hasPendingOutput(send: typeof fetch, commandId: string): boolean {
  return outboxes.get(send)?.hasPendingOutput(commandId) ?? false;
}
export interface TerminalRecord { key: string; event: Record<string, unknown>; durable?: Promise<void> }
interface RecordIndex { owner: string; sequence: number; terminal: boolean; bytes: number }
export interface ReportRejection { status: number; detail: string; at?: string }

function rejectionDetail(value: unknown): string {
  return errorBodyDetail(typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ') : 'Backend rejection reason was not recorded.');
}

function readRejection(data: string): ReportRejection {
  try {
    const value = JSON.parse(data) as number | Partial<ReportRejection>;
    const status = typeof value === 'number' ? value : value?.status;
    return { status: Number.isInteger(status) && Number(status) >= 400 && Number(status) < 500 ? Number(status) : 409,
      detail: rejectionDetail(typeof value === 'object' && value ? value.detail : undefined),
      ...(typeof value === 'object' && value && typeof value.at === 'string' ? { at: value.at } : {}) };
  } catch { return { status: 409, detail: 'Backend rejection reason was not recorded.' }; }
}

/** Private, write-ahead report storage. Only verified acceptance removes evidence. */
export class TerminalOutbox {
  private readonly order = new ReportOrder();
  private readonly index = new Map<string, RecordIndex>();
  private readonly archived = new Set<string>();
  private readonly rejected = new Map<string, ReportRejection>();
  private readonly corrupt = new Set<string>();
  private strictAcknowledgements = false;
  private replaying = false;
  private replayAfter = 0;
  private attemptCleanupAfter = 0;
  private readonly retryAt = new Map<string, number>();
  private readonly deliveries = new Set<string>();
  private batching = false;
  private accepted = 0;
  private bytes = 0;
  private quotaExceeded = false;
  private persistenceFault = false;
  private readonly writes = new Map<string, { event: Record<string, unknown>; done: Promise<void>; bytes: number }>();
  private writingBytes = 0;
  private readonly outputCounts = new Map<string, number>();
  private readonly positions = new Map<string, number>();
  private onPressure?: () => void;
  private onAcceptance?: () => void;
  setPressureHandler(handler: () => void): void { this.onPressure = handler; }
  setAcceptanceHandler(handler: () => void): void { this.onAcceptance = handler; }
  constructor(private readonly directory: string, private readonly onTerminal?: (commandId: string) => void,
    private readonly maxOutputBytes = 1024 * 1024 * 1024, private readonly onWriteError?: (error: Error) => void) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory).filter(name => name.endsWith('.archive'))) {
      const archive = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      if (archive.reportId !== name.slice(0, -8) || archive.action !== 'archive-undeliverable') throw new Error('Invalid report archive.');
      this.archived.add(archive.reportId);
    }
    for (const name of readdirSync(directory)) {
      // Interrupted temporary writes remain evidence and count toward quota.
      this.bytes += statSync(join(directory, name)).size;
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -5);
      try {
        const event = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>;
        if (!event || !durable(event) || typeof event.commandId !== 'string') throw new Error('Invalid retained report.');
        this.index.set(key, { owner: owner(event), sequence: sequence(event), terminal: terminalTypes.has(String(event.type)), bytes: statSync(join(directory, name)).size });
        const rejection = join(directory, `${key}.rejected`);
        if (existsSync(rejection)) this.rejected.set(key, readRejection(readFileSync(rejection, 'utf8')));
      } catch {
        this.corrupt.add(key);
        this.fail(new Error(`Unreadable retained report ${key}; evidence preserved.`));
      }
    }
    for (const [key, record] of this.index) {
      this.order.add(key, record);
      if (!record.terminal) this.countOutput(record.owner, 1);
    }
    // Archives are write-ahead decisions: finish interrupted cleanup on restart.
    for (const key of this.archived) this.acknowledge(key, false);
    if (this.archived.size) syncDirectory(this.directory);
    for (const [key, rejection] of this.rejected) {
      const raw = readFileSync(join(directory, `${key}.rejected`), 'utf8').trim();
      if (this.deletedThread(rejection) || raw === '400') {
        this.archive(key, raw === '400' ? 'legacy-reason-unavailable' : 'thread-deleted');
      }
    }
    this.pruneAttemptHistory();
  }
  negotiate(verified: boolean, batching = false): void { this.strictAcknowledgements = verified; this.batching = verified && batching; }
  usesBatching(): boolean { return this.batching; }
  hasPendingOutput(commandId: string): boolean {
    return (this.outputCounts.get(commandId) ?? 0) > 0;
  }
  status(): { bytes: number; limitBytes: number; pending: number; quarantined: number; corrupt: number; persistenceFault: boolean; verified: boolean; accepted: number; quotaExceeded: boolean; capturingBytes: number; positions: Array<{ commandId: string; sequence: number }> } {
    return { bytes: this.bytes, limitBytes: this.maxOutputBytes, pending: this.index.size,
      quarantined: this.rejected.size, corrupt: this.corrupt.size, persistenceFault: this.persistenceFault, verified: this.strictAcknowledgements, accepted: this.accepted, quotaExceeded: this.quotaExceeded, capturingBytes: this.writingBytes, positions: [...this.positions].map(([commandId, sequence]) => ({ commandId, sequence })) };
  }
  private countOutput(owner: string, delta: number): void {
    const commandId = String(JSON.parse(owner)[0]);
    const count = (this.outputCounts.get(commandId) ?? 0) + delta;
    if (count > 0) this.outputCounts.set(commandId, count);
    else this.outputCounts.delete(commandId);
  }
  private fail(error: Error): void { this.persistenceFault = true; this.onWriteError?.(error); }
  private write(path: string, data: string): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      syncDirectory(this.directory);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private read(key: string): TerminalRecord {
    const pending = this.writes.get(key);
    return { key, event: pending?.event ?? JSON.parse(readFileSync(join(this.directory, `${key}.json`), 'utf8')),
      ...(pending ? { durable: pending.done } : {}) };
  }
  private async writeOutput(key: string, data: string): Promise<void> {
    const path = join(this.directory, `${key}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      await syncDirectoryAsync(this.directory);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private async stored(key: string): Promise<void> { await this.writes.get(key)?.done; }
  commandIds(): string[] { return [...new Set([...this.index.values()].map(record => String(JSON.parse(record.owner)[0])))]; }
  *terminalRecords(): Iterable<TerminalRecord> {
    for (const [key, meta] of this.index) if (meta.terminal) yield this.read(key);
  }
  pending(): TerminalRecord[] {
    return [...this.index].sort((a, b) => a[1].owner.localeCompare(b[1].owner) || a[1].sequence - b[1].sequence).map(([key]) => this.read(key));
  }
  retain(event: Record<string, unknown>): TerminalRecord {
    this.pruneAttemptHistory();
    if (terminalTypes.has(String(event.type))) event = terminalEventPayload(event);
    const output = outputTypes.has(String(event.type));
    const key = digest(JSON.stringify([event.commandId, event.leaseId ?? null, ...(output ? [event.type, sequence(event)] : [])]));
    if (this.archived.has(key)) return { key, event };
    if (!this.index.has(key)) {
      if (!output && this.strictAcknowledgements) {
        // Include all captured output in the terminal receipt, including
        // cancellation/failure paths that bypass executeCommand's result.
        let last: [string, RecordIndex] | undefined;
        for (const entry of this.index) {
          if (!entry[1].terminal && entry[1].owner === owner(event) && (!last || entry[1].sequence > last[1].sequence)) last = entry;
        }
        const tail = last ? this.read(last[0]).event : undefined;
        const lastOutputSequence = tail?.type === 'run.output.batch'
          ? Math.max(...(tail.entries as Array<{ sequence: number }>).map(entry => entry.sequence))
          : tail ? Number(tail.sequence) : -1;
        event = { ...event, lastOutputSequence };
      }
      const data = JSON.stringify(event);
      const bytes = Buffer.byteLength(data);
      // Stop producers at 90%, while allowing their bounded shutdown output
      // into the reserve. Keep the final 3% for exit evidence.
      if (output && (this.bytes + bytes >= this.maxOutputBytes * 0.9 || this.index.size >= 65_536)) {
        this.quotaExceeded = true;
        this.onPressure?.();
      }
      if (output && (this.bytes + bytes > this.maxOutputBytes * 0.97 || this.index.size >= 66_560)) {
        const error = new Error('Durable output storage limit exceeded; capture is incomplete.');
        this.fail(error);
        throw error;
      }
      if (!output && this.bytes + bytes > this.maxOutputBytes) {
        const error = new Error('Durable terminal storage limit exceeded.');
        this.fail(error);
        throw error;
      }
      // A synchronous producer can emit a burst before async writes settle.
      // Spill that burst directly to disk instead of growing memory or losing
      // capture. Normal streaming keeps disk flushes off the event loop.
      const synchronous = !output || this.writingBytes + bytes > 4 * 1024 * 1024;
      if (synchronous) this.write(join(this.directory, `${key}.json`), data);
      this.bytes += bytes;
      this.index.set(key, { owner: owner(event), sequence: sequence(event), terminal: !output, bytes });
      this.order.add(key, this.index.get(key)!);
      if (output) this.countOutput(owner(event), 1);
      if (!synchronous) {
        this.writingBytes += bytes;
        const done = this.writeOutput(key, data);
        this.writes.set(key, { event, done, bytes });
        void done.then(() => { this.writingBytes -= bytes; this.writes.delete(key); }, () => { /* Unproven capture remains bounded and triggers protection. */ });
      }
    }
    if (terminalTypes.has(String(event.type))) this.onTerminal?.(String(event.commandId));
    // First retained payload wins, including when a failed upload races a producer.
    return this.read(key);
  }
  async flush(): Promise<void> { await Promise.all([...this.writes.values()].map(write => write.done)); }
  private acknowledge(key: string, delivered = true): void {
    const record = this.index.get(key);
    if (!record) return;
    if (delivered) {
      this.accepted++;
      this.onAcceptance?.();
      if (!record.terminal) {
        const event = this.read(key).event;
        const entries = event.type === 'run.output.batch' ? event.entries as Array<{ sequence: number }> : [{ sequence: Number(event.sequence) }];
        const commandId = String(event.commandId);
        const last = Math.max(...entries.map(entry => entry.sequence));
        if (Number.isFinite(last)) {
          this.positions.set(commandId, Math.max(last, this.positions.get(commandId) ?? -1));
          if (this.positions.size > 200) this.positions.delete(this.positions.keys().next().value!);
        }
      }
    }
    // A crash before cleanup persists simply replays a durably accepted identity.
    rmSync(join(this.directory, `${key}.json`), { force: true });
    this.bytes -= record.bytes;
    if (this.bytes < this.maxOutputBytes * 0.5) this.quotaExceeded = false;
    if (!record.terminal) this.countOutput(record.owner, -1);
    this.order.remove(key, record);
    this.index.delete(key);
    this.retryAt.delete(key);
    const attempts = join(this.directory, `${key}.attempts`);
    if (!delivered && existsSync(attempts)) { this.bytes -= statSync(attempts).size; rmSync(attempts); }
    const rejection = join(this.directory, `${key}.rejected`);
    if (existsSync(rejection)) { this.bytes -= statSync(rejection).size; rmSync(rejection); syncDirectory(this.directory); }
    this.rejected.delete(key);
  }
  quarantined(commandId: string, leaseId?: string): ({ reportId: string } & ReportRejection) | undefined {
    const reportId = digest(JSON.stringify([commandId, leaseId ?? null]));
    const rejection = this.rejected.get(reportId);
    return rejection ? { reportId, ...rejection } : undefined;
  }
  summaries(): Array<{ id: string; commandId: string; runId: string; sequence: number | null; status: string; rejection?: ReportRejection }> {
    return [...this.index].slice(0, 200).map(([key, meta]) => {
      const event = this.read(key).event;
      const rejection = this.rejected.get(key);
      return { id: key, commandId: String(event.commandId), runId: String(event.runId ?? ''),
        sequence: Number.isFinite(meta.sequence) ? meta.sequence : null,
        status: rejection ? `quarantined (HTTP ${rejection.status})` : 'pending', ...(rejection ? { rejection } : {}) };
    });
  }
  private audit(action: string, key: string, actor: string): void {
    if (!actor.trim()) throw new Error('An intervention actor is required.');
    const data = JSON.stringify({ action, reportId: key, actor, at: new Date().toISOString(), rejection: this.rejected.get(key) });
    this.write(join(this.directory, `${randomUUID()}.audit`), data);
    this.bytes += Buffer.byteLength(data);
  }
  retryQuarantined(key: string, actor: string): void {
    if (!this.rejected.has(key)) throw new Error('Report is not quarantined.');
    this.audit('retry', key, actor);
    const path = join(this.directory, `${key}.rejected`);
    this.bytes -= statSync(path).size;
    rmSync(path);
    syncDirectory(this.directory);
    this.rejected.delete(key);
  }
  discardQuarantined(key: string, actor: string, acknowledgeLoss: boolean): void {
    if (!acknowledgeLoss) throw new Error('Explicitly acknowledge output loss before discarding a report.');
    if (!this.rejected.has(key)) throw new Error('Report is not quarantined.');
    this.audit('discard-with-output-loss', key, actor);
    this.acknowledge(key, false);
  }
  private deletedThread(rejection: ReportRejection): boolean {
    if (rejection.status !== 409) return false;
    let detail = rejection.detail;
    try { detail = JSON.parse(detail)?.detail ?? detail; } catch { /* Older markers stored plain text. */ }
    return detail === 'Report thread no longer exists.';
  }
  private archive(key: string, policy: string): void {
    const data = JSON.stringify({ action: 'archive-undeliverable', reportId: key,
      actor: `daemon-policy:${policy}`, at: new Date().toISOString(),
      event: this.read(key).event, rejection: this.rejected.get(key),
      rejectionRecord: readFileSync(join(this.directory, `${key}.rejected`), 'utf8'),
      attempts: this.attemptTimes(key) });
    // Payload and audit commit together before removal from the active queue.
    this.write(join(this.directory, `${key}.archive`), data);
    this.bytes += Buffer.byteLength(data);
    this.archived.add(key);
    this.acknowledge(key, false);
    syncDirectory(this.directory);
  }
  private attemptTimes(key: string): number[] {
    const path = join(this.directory, `${key}.attempts`);
    if (!existsSync(path)) return [];
    const times: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(times) || !times.every(time => typeof time === 'number' && Number.isFinite(time))) {
      throw new Error(`Invalid report attempt history ${key}; delivery paused.`);
    }
    return times.filter(time => time > Date.now() - 86_400_000);
  }
  private pruneAttemptHistory(): void {
    if (Date.now() < this.attemptCleanupAfter) return;
    this.attemptCleanupAfter = Date.now() + 3_600_000;
    let removed = false;
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith('.attempts')) continue;
      const key = name.slice(0, -9);
      if (this.index.has(key)) continue;
      try {
        if (this.attemptTimes(key).length) continue;
        const path = join(this.directory, name);
        this.bytes -= statSync(path).size;
        rmSync(path);
        removed = true;
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (removed) syncDirectory(this.directory);
  }
  private reserveAttempt(key: string): Response | undefined {
    let times: number[];
    try { times = this.attemptTimes(key); }
    catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    if (times.length >= 10) {
      const retryAt = Math.min(...times) + 86_400_000;
      this.retryAt.set(key, retryAt);
      return new Response('Durable report rolling 24-hour attempt budget exhausted; evidence retained.', {
        status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))) },
      });
    }
    const path = join(this.directory, `${key}.attempts`);
    const previousBytes = existsSync(path) ? statSync(path).size : 0;
    const data = JSON.stringify([...times, Date.now()]);
    // Reserve durably before touching the network; crashes may consume an
    // attempt, but can never reset or exceed the budget.
    this.write(path, data);
    this.bytes += Buffer.byteLength(data) - previousBytes;
    return undefined;
  }
  private deferRetry(key: string, minimumMs = 0): void {
    // Live delivery and the 50–100ms replay loop share one backoff, so a
    // brief outage cannot spend the daily budget before recovery is possible.
    const backoff = Math.min(1000 * 2 ** Math.max(0, this.attemptTimes(key).length - 1), 8000);
    this.retryAt.set(key, Math.max(this.retryAt.get(key) ?? 0, Date.now() + Math.max(backoff, minimumMs)));
  }
  private quarantine(key: string, status: number, detail?: unknown): void {
    if (this.rejected.has(key) || !this.index.has(key)) return;
    const rejection = { status, detail: rejectionDetail(detail), at: new Date().toISOString() };
    const data = JSON.stringify(rejection);
    this.write(join(this.directory, `${key}.rejected`), data);
    this.bytes += Buffer.byteLength(data);
    this.rejected.set(key, rejection);
    if (this.deletedThread(rejection)) this.archive(key, 'thread-deleted');
  }
  private blocked(record: TerminalRecord): boolean {
    const current = this.index.get(record.key);
    return !!current && !this.order.ready(record.key, current);
  }
  private async deliver(send: typeof fetch, input: Parameters<typeof fetch>[0], init: RequestInit, record: TerminalRecord): Promise<Response> {
    if (!terminalTypes.has(String(record.event.type))) return this.sendRecord(send, input, init, record);
    // Let duplicate callers retry under their own deadline rather than wait
    // on a request whose signal may outlive theirs during shutdown.
    if (this.deliveries.has(record.key)) return new Response('Report delivery already in progress.', { status: 503 });
    this.deliveries.add(record.key);
    try { return await this.sendRecord(send, input, init, record); }
    finally { this.deliveries.delete(record.key); }
  }
  private async sendRecord(send: typeof fetch, input: Parameters<typeof fetch>[0], init: RequestInit, record: TerminalRecord): Promise<Response> {
    await this.stored(record.key);
    if (this.archived.has(record.key)) return new Response('Report archived as undeliverable; evidence retained.', { status: 409 });
    const rejection = this.rejected.get(record.key);
    if (rejection) return new Response(`Report quarantined; automatic retries paused. Original HTTP ${rejection.status}: ${rejection.detail} Report ID: ${record.key}. Use relay reports and relay retry-report after stopping the daemon.`, { status: 409 });
    const waitMs = (this.retryAt.get(record.key) ?? 0) - Date.now();
    if (waitMs > 0) return new Response('Durable report retry deferred; evidence retained.', {
      status: 429, headers: { 'Retry-After': String(Math.ceil(waitMs / 1000)) },
    });
    if (this.blocked(record)) return new Response('Earlier output is awaiting delivery.', { status: 503 });
    const event = outputTypes.has(String(record.event.type)) ? { ...record.event, replayed: true } : record.event;
    const originalBody = JSON.stringify(event);
    let sentDigest = '';
    let sentReportId = record.key;
    let payloadBoundIdentity = false;
    const verifiedSend: typeof fetch = async (url, request) => {
      const deferred = this.reserveAttempt(record.key);
      if (deferred) return deferred;
      sentDigest = digest(String(request?.body));
      // A compact representation must not reuse an identity already bound
      // to the full payload. Derive it deterministically for crash/retry safety.
      sentReportId = !payloadBoundIdentity && request?.body === originalBody ? record.key : digest(JSON.stringify([record.key, sentDigest]));
      const headers = new Headers(request?.headers);
      headers.set('X-Relay-Report-Id', sentReportId);
      headers.set('X-Relay-Report-Digest', sentDigest);
      try { return await send(url, { ...request, headers }); }
      catch (error) { this.deferRetry(record.key); throw error; }
    };
    const request = { ...init, body: originalBody };
    let response = terminalTypes.has(String(event.type))
      ? await sendTerminalEvent(verifiedSend, input, request, event) : await verifiedSend(input, request);
    if (response.status === 409 && terminalTypes.has(String(event.type))) {
      const rejection = await response.clone().json().catch(() => null) as { detail?: string } | null;
      if (rejection?.detail === 'Report identity already accepted with a different owner or payload.') {
        // A later terminal acknowledgement can reuse the command's old local
        // slot after acceptance, with a different watermark or result. Keep
        // the old receipt immutable and submit this exact payload separately.
        await response.body?.cancel();
        payloadBoundIdentity = true;
        response = await sendTerminalEvent(verifiedSend, input, request, event);
      }
    }
    if (response.ok) {
      if ((this.strictAcknowledgements || payloadBoundIdentity) && (response.headers.get('X-Relay-Report-Id') !== sentReportId
        || response.headers.get('X-Relay-Report-Digest') !== sentDigest)) {
        await response.body?.cancel();
        this.deferRetry(record.key);
        return new Response('Missing durable acceptance proof.', { status: 503 });
      }
      this.acknowledge(record.key);
    } else if (permanentlyRejected(response.status)) this.quarantine(record.key, response.status, await responseErrorDetail(response.clone()));
    else this.deferRetry(record.key, retryAfterMs(response.headers.get("Retry-After")));
    return response;
  }
  wrapFetch(send: typeof fetch): typeof fetch {
    const wrapped: typeof fetch = async (input, init) => {
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (durable(body) && typeof body.commandId === 'string') return this.deliver(send, input, init, this.retain(body));
      }
      return send(input, init);
    };
    outboxes.set(wrapped, this);
    return wrapped;
  }
  private async replayBatch(send: typeof fetch, eventUrl: string, token: string, ordered: Array<[string, RecordIndex]>, signal?: AbortSignal): Promise<void> {
    const selected = new Set<string>();
    const reports: Array<{ id: string; digest: string; body: string }> = [];
    let bytes = 0;
    for (const [key, current] of ordered) {
      if (reports.length >= 50 || signal?.aborted) break;
      if (!this.index.has(key) || this.rejected.has(key) || this.deliveries.has(key) || Date.now() < (this.retryAt.get(key) ?? 0)) continue;
      if (!this.order.ready(key, current, selected)) continue;
      let record: TerminalRecord;
      try { await this.stored(key); if (!this.index.has(key)) continue; record = this.read(key); } catch { this.fail(new Error(`Unreadable retained report ${key}.`)); continue; }
      const event = outputTypes.has(String(record.event.type)) ? { ...record.event, replayed: true } : record.event;
      const body = JSON.stringify(event);
      const size = Buffer.byteLength(JSON.stringify(body)) + 200;
      if (bytes + size > 2 * 1024 * 1024) {
        if (reports.length === 0) {
          const response = await this.deliver(send, eventUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(EVENT_REQUEST_TIMEOUT_MS)]) }, record);
          await response.body?.cancel();
          continue;
        }
        break;
      }
      if (this.deliveries.has(key)) continue;
      const deferred = this.reserveAttempt(key);
      if (deferred) { await deferred.body?.cancel(); continue; }
      reports.push({ id: key, digest: digest(body), body });
      selected.add(key);
      bytes += size;
    }
    if (!reports.length) return;
    for (const key of selected) this.deliveries.add(key);
    let response: Response;
    try {
      response = await send(eventUrl.replace(/\/events$/, '/reports'), { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ reports }),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(EVENT_REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      for (const key of selected) this.deferRetry(key);
      throw error;
    } finally { for (const key of selected) this.deliveries.delete(key); }
    if (response.status === 413) {
      await response.body?.cancel();
      // A proxy may cap batches below our bound. Individual delivery lets
      // terminal reports negotiate their compact form with verified receipts.
      for (const key of selected) {
        if (signal?.aborted) break;
        if (!this.index.has(key)) continue;
        const single = await this.deliver(send, eventUrl, { method: 'POST', headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(EVENT_REQUEST_TIMEOUT_MS)]),
        }, this.read(key));
        await single.body?.cancel();
      }
      return;
    }
    if (!response.ok) {
      const minimumMs = retryAfterMs(response.headers.get("Retry-After"));
      for (const key of selected) this.deferRetry(key, minimumMs);
      this.replayAfter = Date.now() + minimumMs;
      await response.body?.cancel();
      return;
    }
    const result = await response.json() as { receipts?: Array<{ id: string; digest: string; status: number; detail?: string }> };
    const expected = new Map(reports.map(report => [report.id, report.digest]));
    for (const receipt of result.receipts ?? []) {
      if (expected.get(receipt.id) !== receipt.digest) continue;
      if (receipt.status === 200) this.acknowledge(receipt.id);
      else if (receipt.status === 409 && this.index.get(receipt.id)?.terminal
        && (!receipt.detail || receipt.detail === 'Report identity already accepted with a different owner or payload.')) {
        // Older batch receipts carry no rejection detail. Probe individually so only
        // an explicit identity collision can use the payload-bound fallback.
        try {
          const single = await this.deliver(send, eventUrl, { method: 'POST', headers: {
            'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(EVENT_REQUEST_TIMEOUT_MS)]),
          }, this.read(receipt.id));
          await single.body?.cancel();
        } catch { /* Retain the report for the next replay attempt. */ }
      } else if (permanentlyRejected(receipt.status)) this.quarantine(receipt.id, receipt.status, receipt.detail);
    }
    for (const key of selected) if (this.index.has(key) && !this.rejected.has(key)) this.deferRetry(key);
  }
  async replay(send: typeof fetch, eventUrl: string, token: string, signal?: AbortSignal): Promise<void> {
    if (this.replaying || Date.now() < this.replayAfter) return;
    this.replaying = true;
    try {
      // Terminal evidence goes first. Round-robin streams prevent one backlog
      // monopolizing replay; only read a payload when it is actually attempted.
      const ordered = this.order.candidates(key => !this.rejected.has(key)
        && !this.deliveries.has(key)
        && Date.now() >= (this.retryAt.get(key) ?? 0))
        .map(key => [key, this.index.get(key)!] as [string, RecordIndex]);
      if (this.batching) {
        try { await this.replayBatch(send, eventUrl, token, ordered, signal); } catch { /* Retry the same durable identities next tick. */ }
        return;
      }
      let attempts = 0;
      for (const [key] of ordered) {
        if (signal?.aborted || attempts >= 50) return;
        if (!this.index.has(key) || this.rejected.has(key) || Date.now() < (this.retryAt.get(key) ?? 0)) continue;
        let record: TerminalRecord;
        try { await this.stored(key); if (!this.index.has(key)) continue; record = this.read(key); } catch { this.fail(new Error(`Unreadable retained report ${key}.`)); continue; }
        if (this.blocked(record)) continue;
        attempts++;
        try {
          const response = await this.deliver(send, eventUrl, { method: 'POST', headers: {
            'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(EVENT_REQUEST_TIMEOUT_MS)]),
          }, record);
          await response.body?.cancel();
        } catch { /* Retained evidence is retried; unrelated streams continue. */ }
      }
    } finally { this.replaying = false; }
  }
}
