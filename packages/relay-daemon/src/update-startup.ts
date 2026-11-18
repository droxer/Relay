/** Confirms that the service started by this particular installer reached its backend. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function validUpdateAttempt(value: string | undefined): value is string {
  return !!value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

function startupDirectory(stateDir: string, attempt: string): string {
  return join(stateDir, 'update-requests', `startup-${attempt}`);
}

export function requestUpdateStartup(stateDir: string) {
  const attempt = randomUUID();
  const directory = startupDirectory(stateDir, attempt);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return {
    attempt,
    async wait(signal: AbortSignal): Promise<void> {
      while (!existsSync(join(directory, 'registered'))) await delay(250, undefined, { signal });
      signal.throwIfAborted();
    },
    release(): void { rmSync(directory, { recursive: true, force: true }); },
  };
}

export function confirmUpdateStartup(stateDir: string, attempt: string | undefined): void {
  if (!validUpdateAttempt(attempt)) return;
  // The installed service retains the attempt ID. Once the installer cleans up,
  // ordinary daemon restarts should never recreate the acknowledgement.
  try { writeFileSync(join(startupDirectory(stateDir, attempt), 'registered'), '', { mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
