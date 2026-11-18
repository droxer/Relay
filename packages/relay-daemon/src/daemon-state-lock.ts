import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireWorkspaceLockClaim } from "./workspace-lock-claims.js";

interface StateOwner { pid: number; token: string }

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function readOwner(path: string): StateOwner | undefined {
  let owner: Partial<StateOwner> | null;
  try { owner = JSON.parse(readFileSync(path, "utf8")) as Partial<StateOwner> | null; }
  catch (error) { if (missing(error)) return undefined; throw error; }
  if (!owner || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") {
    throw new Error("Cannot verify the owner of this daemon state directory.");
  }
  return owner as StateOwner;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** The journal, ledger, and outbox share one writer for the daemon's lifetime. */
export async function acquireDaemonStateLock(directory: string, signal?: AbortSignal): Promise<() => void> {
  const path = join(directory, "daemon.lock");
  // Serialize owner inspection and stale-lock recovery across processes.
  const releaseClaim = await acquireWorkspaceLockClaim(path, signal);
  const owner = { pid: process.pid, token: randomUUID() };
  try {
    signal?.throwIfAborted();
    const prior = readOwner(path);
    if (prior && isAlive(prior.pid)) {
      throw new Error(`Another Relay process (PID ${prior.pid}) is already using this daemon state directory.`);
    }
    // Publish complete owner metadata at once, including after an earlier crash.
    const temporary = `${path}.${owner.token}.tmp`;
    writeFileSync(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    releaseClaim();
  }

  const release = (): void => {
    process.off("exit", release);
    try { if (readOwner(path)?.token === owner.token) unlinkSync(path); }
    catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) setTimeout(release, 250).unref();
    }
  };
  process.once("exit", release);
  return release;
}
