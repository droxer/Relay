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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { acquireWorkspaceLockClaim } from "./workspace-lock-claims.js";

const LOCK_RETRY_MS = 25;
const LOCK_RELEASE_RETRY_MS = 250;
const INCOMPLETE_LOCK_STALE_MS = 30_000;

interface LockOwner {
  pid: number;
  token: string;
  createdAt: number;
  sessionId?: string;
}

interface WorkspaceGateObserver {
  sessionId: string;
  /** null means the wait ended; undefined means another process owns the lock. */
  onWaiting?: (blockingSessionId: string | null | undefined) => Promise<void>;
}

interface WorkspaceNotification {
  next?: { owner: string | null | undefined };
}

/** Serializes non-Project runs that target the same physical workspace. */
export class WorkspaceRunGate {
  private readonly owners = new Map<string, string>();
  private readonly waiters = new Map<string, Set<WorkspaceGateObserver>>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly notifications = new WeakMap<WorkspaceGateObserver, WorkspaceNotification>();

  private notify(observer: WorkspaceGateObserver, owner: string | null | undefined): void {
    if (!observer.onWaiting) return;
    const pending = this.notifications.get(observer);
    if (pending) {
      pending.next = { owner };
      return;
    }
    const notification: WorkspaceNotification = { next: { owner } };
    this.notifications.set(observer, notification);
    void this.sendNotifications(observer, notification);
  }

  private async sendNotifications(observer: WorkspaceGateObserver, notification: WorkspaceNotification): Promise<void> {
    // Keep delivery ordered and only retain the latest unsent state while the
    // backend is slow. Workspace access depends solely on the local locks.
    while (notification.next) {
      const { owner } = notification.next;
      notification.next = undefined;
      try { await observer.onWaiting?.(owner); }
      catch { /* Status delivery is advisory. */ }
    }
    this.notifications.delete(observer);
  }

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
        this.notify(observer, this.owners.get(key));
      }
      await waitForTurn(predecessor, signal);
      signal?.throwIfAborted();
      releaseFileLock = await acquireFileLock(this.workspaceRoot, key, signal, observer?.sessionId,
        observer ? id => this.notify(observer, id) : undefined);
      if (observer) {
        this.waiters.get(key)?.delete(observer);
        this.owners.set(key, observer.sessionId);
        this.notify(observer, null);
        for (const waiter of this.waiters.get(key) ?? []) {
          this.notify(waiter, observer.sessionId);
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
  sessionId?: string,
  onWaiting?: (blockingSessionId: string | undefined) => void,
): Promise<(() => void) | undefined> {
  if (!workspaceRoot) return undefined;
  const physicalKey = canonicalPhysicalPath(key);
  const physicalRoot = canonicalPhysicalPath(workspaceRoot);
  const fromRoot = relative(physicalRoot, physicalKey);
  const external = fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  // Existing internal workspaces keep their lock namespace across upgrades.
  // Linked directories share one namespace regardless of the daemon's root.
  const lockDirectory = workspaceLockDirectory(external ? physicalKey : physicalRoot);
  ensureLockDirectory(lockDirectory);
  const digest = createHash("sha256")
    .update(physicalKey)
    .digest("hex");
  const lockPath = join(lockDirectory, `${digest}.lock`);
  const owner: LockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
    sessionId,
  };

  let lastOwner: string | undefined;
  let reportedWait = false;
  const reportWait = async () => {
    let blockingSessionId: string | undefined;
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
      if (typeof lock.sessionId === "string") blockingSessionId = lock.sessionId;
    } catch { /* A lock can be released while it is inspected. */ }
    if (!reportedWait || blockingSessionId !== lastOwner) {
      onWaiting?.(blockingSessionId);
      lastOwner = blockingSessionId;
      reportedWait = true;
    }
  };
  // Every acquiring daemon joins the ordering before inspecting or changing
  // the shared lock. Keep the legacy file/namespace for existing owners.
  const releaseClaim = await acquireWorkspaceLockClaim(lockPath, signal, reportWait);
  try {
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
        await reportWait();
        await waitForRetry(signal);
      }
    }
  } finally {
    releaseClaim();
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
  // Windows reports no POSIX permission bits; the per-user temp directory's ACL is what keeps it private.
  if (process.platform !== "win32" && (lstatSync(path).mode & 0o077) !== 0) {
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
  } catch (error) {
    // Waiters still see this PID as live. Retry in the background and recheck
    // the token before unlinking so cleanup cannot remove a replacement lock.
    if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) {
      setTimeout(() => releaseOwnedLock(lockPath, token), LOCK_RELEASE_RETRY_MS).unref();
    }
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
