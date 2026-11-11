import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readSync, fstatSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { syncDirectory } from './sync-directory.js';

/** Exact, durable command fences: fixed-size hashes on disk, bounded hot cache.
 * Resolved identities are never expired merely to reclaim memory. */
export class AdmissionLedger {
  private readonly cache = new Set<string>();
  constructor(private readonly directory: string, private readonly capacity = 4096) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  get cachedCount(): number { return this.cache.size; }
  private identity(id: string): Buffer { return createHash('sha256').update(id).digest(); }
  private path(hash: Buffer): string { return join(this.directory, `${hash.toString('hex').slice(0, 3)}.fences`); }
  private remember(id: string): void {
    this.cache.delete(id);
    this.cache.add(id);
    if (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
  }
  has(id: string): boolean {
    if (this.cache.has(id)) { this.remember(id); return true; }
    const hash = this.identity(id);
    let fd: number;
    try { fd = openSync(this.path(hash), 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    try {
      // A torn append cannot silently drop an execution fence.
      if (fstatSync(fd).size % 32 !== 0) throw new Error('Admission ledger is incomplete; execution requires reconciliation.');
      const buffer = Buffer.alloc(32 * 1024);
      let count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        if (count % 32 !== 0) throw new Error('Admission ledger read is incomplete; execution requires reconciliation.');
        for (let offset = 0; offset < count; offset += 32) {
          if (buffer.subarray(offset, offset + 32).equals(hash)) { this.remember(id); return true; }
        }
      }
      return false;
    } finally { closeSync(fd); }
  }
  add(id: string): void {
    if (this.has(id)) return;
    const hash = this.identity(id);
    const fd = openSync(this.path(hash), 'a', 0o600);
    try {
      let offset = 0;
      while (offset < hash.length) {
        const bytes = writeSync(fd, hash, offset, hash.length - offset);
        if (bytes === 0) throw new Error('Admission ledger write made no progress.');
        offset += bytes;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory(this.directory);
    this.remember(id);
  }
}
