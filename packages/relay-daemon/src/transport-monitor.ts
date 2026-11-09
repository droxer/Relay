import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncDirectory } from './sync-directory.js';

interface State {
  incident?: string;
  startedAt?: number;
  failed: Record<string, number>;
  causes: string[];
  healthySince?: number;
  recovered: boolean;
  attempts: number;
}
/** Durable local incident identity, independent of the failed network channel. */
export class TransportMonitor {
  private state: State;
  private readonly path: string;
  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'transport.json');
    this.state = { failed: {}, causes: [], recovered: false, attempts: 0 };
    if (existsSync(this.path)) {
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as State;
      if (!saved || !Array.isArray(saved.causes) || !saved.failed || typeof saved.failed !== 'object') throw new Error('Invalid transport incident state.');
      this.state = saved;
    }
  }
  private save(): void {
    const temporary = `${this.path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.path);
    syncDirectory(this.directory);
  }
  failure(channel: string): void {
    if (this.state.recovered) this.state = { failed: {}, causes: [], recovered: false, attempts: 0 };
    this.state.failed[channel] ??= this.now();
    this.state.startedAt ??= this.now();
    this.state.healthySince = undefined;
    this.state.attempts++;
    this.save();
  }
  success(channel: string): void {
    if (!(channel in this.state.failed)) return;
    delete this.state.failed[channel];
    if (Object.keys(this.state.failed).length === 0) this.state.healthySince = this.now();
    this.save();
  }
  cause(cause: string, active: boolean): void {
    if (active === this.state.causes.includes(cause)) return;
    if (active) {
      if (this.state.recovered) this.state = { failed: {}, causes: [], recovered: false, attempts: 0 };
      this.state.causes.push(cause);
      this.state.startedAt ??= this.now();
      this.state.incident ??= randomUUID();
    } else {
      this.state.causes = this.state.causes.filter(item => item !== cause);
      if (Object.keys(this.state.failed).length === 0) this.state.healthySince = this.now();
    }
    this.save();
  }
  snapshot(): { incident?: string; startedAt?: number; causes: string[]; recovered: boolean; attempts: number; observedAt: number; state: string } {
    const before = JSON.stringify(this.state);
    const failed = Object.values(this.state.failed);
    const outage = failed.length > 0 && this.now() - Math.min(...failed) >= 60_000;
    if (outage && !this.state.causes.includes('communication')) {
      this.state.causes.push('communication');
      this.state.incident ??= randomUUID();
    }
    if (failed.length === 0 && this.state.healthySince !== undefined && this.now() - this.state.healthySince >= 10_000) {
      this.state.causes = this.state.causes.filter(item => item !== 'communication');
    }
    this.state.recovered = !!this.state.incident && failed.length === 0 && this.state.causes.length === 0
      && this.state.healthySince !== undefined && this.now() - this.state.healthySince >= 10_000;
    if (JSON.stringify(this.state) !== before) this.save();
    return { incident: this.state.incident, startedAt: this.state.startedAt, causes: [...this.state.causes], recovered: this.state.recovered,
      attempts: this.state.attempts, observedAt: this.now(), state: this.state.causes.includes('revoked') ? 'revoked' : failed.length ? 'retrying' : 'healthy' };
  }
}
