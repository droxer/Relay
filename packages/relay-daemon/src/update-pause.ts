/** Local admission handshake: the daemon acknowledges only between command batches. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface UpdateRequest { pid: number; nonce: string }

function request(path: string): UpdateRequest | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as UpdateRequest | null;
    if (!value || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(value.nonce)) return undefined;
    try { process.kill(value.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined; }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function requests(directory: string): UpdateRequest[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => {
    const value = request(join(directory, name));
    return value ? [value] : [];
  });
}

export function requestUpdatePause(stateDir: string): { acknowledged(): boolean; release(): void } {
  const directory = join(stateDir, 'update-requests');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const path = join(directory, `${nonce}.json`);
  const ack = join(directory, `${nonce}.paused`);
  writeFileSync(path, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 });
  // Unique files ensure a racing updater can never remove another updater's request.
  if (requests(directory).some(value => value.nonce !== nonce)) {
    rmSync(path, { force: true });
    throw new Error('Another update is already in progress for this computer.');
  }
  return {
    acknowledged: () => {
      try { return readFileSync(ack, 'utf8') === nonce; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    },
    release: () => { rmSync(path, { force: true }); rmSync(ack, { force: true }); },
  };
}

/** Call only outside command processing: acknowledgement proves all prior admissions are journaled. */
export function acknowledgeUpdatePause(stateDir: string): boolean {
  const directory = join(stateDir, 'update-requests');
  const pending = requests(directory);
  for (const value of pending) {
    writeFileSync(join(directory, `${value.nonce}.paused`), value.nonce, { mode: 0o600 });
  }
  return pending.length > 0;
}
