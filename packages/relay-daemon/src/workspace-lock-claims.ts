import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface Claim {
  id: string;
  // null means the process is still choosing its ticket (including a read
  // concurrent with its write). Do not pass it until the write has finished.
  ticket: number | null;
}

/** Serialize creation and stale recovery of one workspace's legacy lock.
 *
 * Lamport's bakery protocol uses one unique file per contender. Unlike a
 * shared recovery lock, a dead contender's file can be removed safely: nobody
 * reuses its name, so cleanup can never unlink a replacement owner's claim.
 * Filesystem reads/writes must be coherent between local daemon processes.
 */
export async function acquireWorkspaceLockClaim(
  lockPath: string, signal?: AbortSignal, onWaiting?: () => Promise<void>,
): Promise<() => void> {
  signal?.throwIfAborted();
  const directory = `${lockPath}.claims`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `${process.pid}-${randomUUID()}`;
  const path = join(directory, id);
  const selected = join(directory, `.${id}.ticket`);
  // Publish choosing before reading other tickets. An empty/partial file is
  // also choosing, so a writer interrupted between open and write is safe.
  const release = () => {
    removeOwnFile(selected);
    removeOwnFile(path);
  };
  try {
    writeFileSync(path, "null", { flag: "wx", mode: 0o600 });
    const ticket = Math.max(0, ...readClaims(directory, id).map(claim => claim.ticket ?? 0)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error("Workspace lock ticket limit exceeded.");
    // Publish the whole number atomically: a partial write of ticket 12 must
    // not be read as ticket 1 while another contender is choosing its number.
    writeFileSync(selected, JSON.stringify(ticket), { flag: "wx", mode: 0o600 });
    renameSync(selected, path);
    while (true) {
      signal?.throwIfAborted();
      const blocked = readClaims(directory, id).some(claim => claim.ticket === null
        || claim.ticket < ticket || (claim.ticket === ticket && claim.id < id));
      if (!blocked) return release;
      await onWaiting?.();
      await delay(25, undefined, { signal });
    }
  } catch (error) {
    release();
    throw error;
  }
}

function readClaims(directory: string, ownId: string): Claim[] {
  const claims: Claim[] = [];
  for (const id of readdirSync(directory)) {
    if (id === ownId || id.startsWith(".")) continue;
    const pid = Number(id.split("-", 1)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`Invalid workspace lock claim: ${id}`);
    }
    const path = join(directory, id);
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (hasCode(error, "ESRCH")) {
        try { unlinkSync(path); }
        catch (unlinkError) { if (!hasCode(unlinkError, "ENOENT")) throw unlinkError; }
        removeOwnFile(join(directory, `.${id}.ticket`));
        continue;
      }
      // EPERM does not prove exit. Keep the contender in the ordering.
    }
    let contents: string;
    try { contents = readFileSync(path, "utf8"); }
    catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    let ticket: unknown;
    try { ticket = JSON.parse(contents); }
    catch { ticket = null; }
    claims.push({ id, ticket: typeof ticket === "number" && Number.isSafeInteger(ticket) && ticket > 0 ? ticket : null });
  }
  return claims;
}

function removeOwnFile(path: string): void {
  try { unlinkSync(path); }
  catch { /* Never reused: a dead owner's claim can be reclaimed safely later. */ }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
