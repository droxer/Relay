import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const LOCK_RETRY_MS = 25;
const INCOMPLETE_LOCK_STALE_MS = 30_000;

interface LockOwner {
  pid: number;
  token: string;
  createdAt: number;
  sessionId?: string;
}

export interface WorkspaceGateObserver {
  sessionId: string;
  /** null means the wait ended; undefined means another process owns the lock. */
  onWaiting?: (blockingSessionId: string | null | undefined) => Promise<void>;
}

/** Serializes writes that target the same physical project workspace. */
export class WorkspaceRunGate {
  private readonly owners = new Map<string, string>();
  private readonly waiters = new Map<string, Set<WorkspaceGateObserver>>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly workspaceRoot?: string) {}

  async run<T>(
    key: string | undefined,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
    observer?: WorkspaceGateObserver,
  ): Promise<T> {
    if (!key) return work();

    const queued = this.tails.has(key);
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const ownTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => ownTurn);
    this.tails.set(key, tail);
    let releaseFileLock: (() => void) | undefined;

    try {
      if (queued && observer) {
        const waiters = this.waiters.get(key) ?? new Set<WorkspaceGateObserver>();
        waiters.add(observer);
        this.waiters.set(key, waiters);
        await observer.onWaiting?.(this.owners.get(key));
      }
      await waitForTurn(predecessor, signal);
      signal?.throwIfAborted();
      releaseFileLock = await acquireFileLock(this.workspaceRoot, key, signal, observer);
      if (observer) {
        this.waiters.get(key)?.delete(observer);
        this.owners.set(key, observer.sessionId);
        await observer.onWaiting?.(null);
        for (const waiter of this.waiters.get(key) ?? []) {
          // A cancelled queued run must not fail the current workspace owner.
          await waiter.onWaiting?.(observer.sessionId).catch(() => undefined);
        }
      }
      signal?.throwIfAborted();
      return await work();
    } finally {
      if (observer) {
        this.waiters.get(key)?.delete(observer);
        if (this.owners.get(key) === observer.sessionId) this.owners.delete(key);
        if (!this.waiters.get(key)?.size) this.waiters.delete(key);
      }
      releaseFileLock?.();
      release();
      if (this.tails.get(key) === tail) {
        void tail.finally(() => {
          if (this.tails.get(key) === tail) this.tails.delete(key);
        });
      }
    }
  }
}

async function acquireFileLock(
  workspaceRoot: string | undefined,
  key: string,
  signal: AbortSignal | undefined,
  observer?: WorkspaceGateObserver,
): Promise<(() => void) | undefined> {
  if (!workspaceRoot) return undefined;
  const lockDirectory = workspaceLockDirectory(workspaceRoot);
  ensureLockDirectory(lockDirectory);
  const digest = createHash("sha256")
    .update(canonicalPhysicalPath(key))
    .digest("hex");
  const lockPath = join(lockDirectory, `${digest}.lock`);
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
    sessionId: observer?.sessionId,
  };

  let lastOwner: string | undefined;
  let reportedWait = false;
  while (true) {
    signal?.throwIfAborted();
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(owner), "utf8");
      closeSync(descriptor);
      descriptor = undefined;
      return () => releaseOwnedLock(lockPath, owner.token);
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch {
          // The failed write is already the primary error.
        }
      }
      if (!hasCode(error, "EEXIST")) throw error;
      if (staleLock(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if (!hasCode(unlinkError, "ENOENT")) {
            await waitForRetry(signal);
          }
        }
        continue;
      }
      let blockingSessionId: string | undefined;
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
        if (typeof lock.sessionId === "string") blockingSessionId = lock.sessionId;
      } catch { /* A lock can be replaced while it is inspected. */ }
      if (!reportedWait || blockingSessionId !== lastOwner) {
        await observer?.onWaiting?.(blockingSessionId);
        lastOwner = blockingSessionId;
        reportedWait = true;
      }
      await waitForRetry(signal);
    }
  }
}

export function workspaceLockDirectory(workspaceRoot: string): string {
  const canonicalRoot = canonicalPhysicalPath(workspaceRoot);
  const rootDigest = createHash("sha256").update(canonicalRoot).digest("hex");
  return join(workspaceLockBase(), rootDigest);
}

function canonicalPhysicalPath(path: string): string {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...missingSegments.reverse());
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

function ensureLockDirectory(lockDirectory: string): void {
  ensurePrivateDirectory(workspaceLockBase(), "Workspace lock root");
  ensurePrivateDirectory(lockDirectory, "Workspace lock directory");
}

function workspaceLockBase(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return join(tmpdir(), `relay-workspace-locks${uid === undefined ? "" : `-${uid}`}`);
}

function ensurePrivateDirectory(path: string, label: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const initial = lstatSync(path);
  if (initial.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${path}.`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && initial.uid !== uid) {
    throw new Error(`${label} is owned by another user: ${path}.`);
  }
  chmodSync(path, 0o700);
  if ((lstatSync(path).mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are too broad: ${path}.`);
  }
}

function staleLock(lockPath: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    if (typeof owner.pid === "number" && Number.isInteger(owner.pid)) {
      return !processIsAlive(owner.pid);
    }
  } catch {
    // A creator may be between the exclusive open and its metadata write.
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > INCOMPLETE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function releaseOwnedLock(lockPath: string, token: string): void {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    if (owner.token === token) unlinkSync(lockPath);
  } catch {
    // Never mask the run result during cleanup. A surviving lock is recovered
    // by PID liveness (or the incomplete-lock timeout) on the next acquire.
  }
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === code,
  );
}

async function waitForRetry(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, LOCK_RETRY_MS);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Run cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForTurn(
  predecessor: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await predecessor.catch(() => undefined);
    return;
  }
  signal.throwIfAborted();
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => rejectAborted(signal.reason ?? new Error("Run cancelled."));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([predecessor.catch(() => undefined), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
