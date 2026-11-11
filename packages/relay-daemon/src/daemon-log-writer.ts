import { appendFile, open, opendir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { withExecutionDeadline } from './execution-deadline.js';

export interface DaemonLogWriterOptions {
  maxQueueBytes?: number;
  maxFileBytes?: number;
  maxRunBytes?: number;
  maxRunFiles?: number;
  closeTimeoutMs?: number;
  append?(path: string, data: string): Promise<void>;
  warn?(message: string): void;
}
interface RunLog { bytes: number; modified: number }

/** Diagnostic logs may omit records under pressure; execution evidence never uses this queue. */
export class DaemonLogWriter {
  private pending: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queuedEntries = 0;
  private omitted = 0;
  private warnedAt = -Infinity;
  private closed = false;
  private initialized = false;
  private readonly runs = new Map<string, RunLog>();
  private runBytes = 0;
  private readonly queueLimit: number;
  private readonly fileLimit: number;
  private readonly runLimit: number;
  private readonly fileCount: number;
  constructor(private readonly directory: string, private readonly aggregate: string,
    private readonly options: DaemonLogWriterOptions = {}) {
    this.queueLimit = Math.max(1, options.maxQueueBytes ?? 4 * 1024 ** 2);
    this.fileLimit = Math.max(1, options.maxFileBytes ?? 10 * 1024 ** 2);
    this.runLimit = Math.max(0, options.maxRunBytes ?? 100 * 1024 ** 2);
    this.fileCount = Math.max(0, options.maxRunFiles ?? 1000);
  }
  get pendingBytes(): number { return this.queuedBytes; }
  get dropped(): number { return this.omitted; }
  private warn(message: string): void {
    if (this.options.warn) this.options.warn(message);
    else process.stderr.write(`Relay daemon log: ${message}\n`);
  }
  write(line: string, runFile?: string): void {
    if (this.closed) return;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.fileLimit || this.queuedBytes + bytes > this.queueLimit || this.queuedEntries >= 4096) {
      this.omitted++;
      if (Date.now() - this.warnedAt >= 30_000) {
        this.warnedAt = Date.now();
        this.warn(`Diagnostic log records omitted under pressure (${this.omitted} total); durable output is preserved separately.`);
      }
      return;
    }
    this.queuedBytes += bytes;
    this.queuedEntries++;
    this.pending = this.pending.then(async () => {
      await this.initialize();
      const size = await this.size(this.aggregate);
      if (size + bytes > this.fileLimit) {
        await rm(`${this.aggregate}.1`, { force: true });
        if (size > this.fileLimit) {
          await writeFile(`${this.aggregate}.1`, await this.tail(this.aggregate, size), { mode: 0o600 });
          await writeFile(this.aggregate, '', { mode: 0o600 });
        } else {
          try { await rename(this.aggregate, `${this.aggregate}.1`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      await this.append(this.aggregate, line);
      if (runFile) {
        const path = join(this.directory, `${runFile}.log`);
        const prior = this.runs.get(path)?.bytes ?? await this.size(path);
        if (prior + bytes > this.fileLimit) await writeFile(path, line, { mode: 0o600 });
        else await this.append(path, line);
        const next = prior + bytes > this.fileLimit ? bytes : prior + bytes;
        this.runBytes += next - (this.runs.get(path)?.bytes ?? 0);
        this.runs.set(path, { bytes: next, modified: Date.now() });
        await this.prune();
      }
    }).catch(error => this.warn(`Write failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.queuedBytes -= bytes; this.queuedEntries--; });
  }
  private async append(path: string, line: string): Promise<void> {
    if (this.options.append) await this.options.append(path, line);
    else await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
  }
  private async size(path: string): Promise<number> {
    try { return (await stat(path)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  }
  private async tail(path: string, size: number): Promise<Buffer> {
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size, this.fileLimit));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return buffer.subarray(0, bytesRead);
    } finally { await file.close(); }
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.runs.clear();
    this.runBytes = 0;
    // Stream an old installation's directory; retention must also bound startup memory.
    for await (const entry of await opendir(this.directory)) {
      const name = entry.name;
      if (!/\.(log|jsonl)$/.test(name) || name === basename(this.aggregate) || name === 'service.log') continue;
      const path = join(this.directory, name);
      const info = await stat(path);
      if (!info.isFile()) continue;
      const bytes = Math.min(info.size, this.fileLimit);
      if (info.size > bytes) await writeFile(path, await this.tail(path, info.size), { mode: 0o600 });
      this.runs.set(path, { bytes, modified: info.mtimeMs });
      this.runBytes += bytes;
      await this.prune();
    }
    await this.prune();
    this.initialized = true;
  }
  private async prune(): Promise<void> {
    if (this.runs.size <= this.fileCount && this.runBytes <= this.runLimit) return;
    const oldest = [...this.runs].sort((a, b) => a[1].modified - b[1].modified);
    for (const [path, log] of oldest) {
      if (this.runs.size <= this.fileCount && this.runBytes <= this.runLimit) break;
      await rm(path, { force: true });
      this.runs.delete(path);
      this.runBytes -= log.bytes;
    }
  }
  async flush(): Promise<void> { await this.pending; }
  async close(): Promise<void> {
    this.closed = true;
    try { await withExecutionDeadline(this.flush(), this.options.closeTimeoutMs ?? 1000, 'Diagnostic log shutdown'); }
    catch (error) { this.warn(error instanceof Error ? error.message : String(error)); }
  }
}
