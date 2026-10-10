import { resolve } from "node:path";
import type { ExecutionManager } from "./execution.js";
import type { ActiveOrchestratorSession } from "./sandbox-session.js";

export interface GuestStartInput {
  workspace: string;
  boxName: string;
  manager: ExecutionManager;
}

export interface GuestPoolOptions {
  /** Most guests booted at once; the daemon passes its run capacity. */
  capacity: number;
  boxName(slot: number): string;
  createManager(): ExecutionManager;
  start(input: GuestStartInput): Promise<ActiveOrchestratorSession>;
}

export interface GuestLease {
  readonly workspace: string;
  readonly manager: ExecutionManager;
  release(): void;
}

interface Guest {
  readonly workspace: string;
  readonly slot: number;
  readonly manager: ExecutionManager;
  readonly starting: Promise<ActiveOrchestratorSession>;
  booted: boolean;
  users: number;
  lastReleasedAt: number;
}

/**
 * BoxLite guests keyed by the one host workspace each mounts.
 *
 * A guest only ever sees its own thread's directory, so concurrent runs on
 * different threads need different guests. Runs on the same workspace share
 * one (the daemon's WorkspaceRunGate already serializes them). An idle guest
 * stays booted for reuse and is replaced, least recently used first, only
 * when another workspace needs its slot; a guest someone is using is never
 * stopped underneath them.
 */
export class GuestPool {
  private readonly guests = new Map<string, Guest>();
  private readonly freeSlots: number[];
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly options: GuestPoolOptions) {
    const capacity = Math.max(1, Math.floor(options.capacity));
    this.freeSlots = Array.from({ length: capacity }, (_, slot) => slot);
  }

  /** Lease the guest that mounts `hostWorkspace`, booting one if needed. */
  async acquire(hostWorkspace: string, signal?: AbortSignal): Promise<GuestLease> {
    const workspace = resolve(hostWorkspace);
    for (;;) {
      this.assertOpen(signal);
      const guest = this.guests.get(workspace) ?? this.claimSlot(workspace);
      if (guest) return this.lease(guest);
      await this.nextRelease(signal);
    }
  }

  /**
   * Lease any running guest, booting one on `fallbackWorkspace` only when none
   * exists. For workspace-agnostic work (agent preflight, model discovery) that
   * must not wait for a run to finish just to borrow a slot.
   */
  async acquireAny(fallbackWorkspace: string, signal?: AbortSignal): Promise<GuestLease> {
    this.assertOpen(signal);
    // Prefer a guest that is already up; one still booting may yet fail.
    const booted = [...this.guests.values()].find((guest) => guest.booted);
    return booted ? this.lease(booted) : this.acquire(fallbackWorkspace, signal);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake();
    const guests = [...this.guests.values()];
    this.guests.clear();
    await Promise.all(guests.map((guest) => stopGuest(guest)));
  }

  private claimSlot(workspace: string): Guest | undefined {
    const free = this.freeSlots.shift();
    if (free !== undefined) return this.boot(workspace, free);
    const idle = [...this.guests.values()]
      .filter((guest) => guest.users === 0)
      .sort((left, right) => left.lastReleasedAt - right.lastReleasedAt)[0];
    if (!idle) return undefined;
    this.guests.delete(idle.workspace);
    return this.boot(workspace, idle.slot, stopGuest(idle));
  }

  private boot(workspace: string, slot: number, previous: Promise<void> = Promise.resolve()): Guest {
    const manager = this.options.createManager();
    const boxName = this.options.boxName(slot);
    // The replaced guest owns this slot's box name until it has stopped.
    const starting = previous.then(() => this.options.start({ workspace, boxName, manager }));
    const guest: Guest = { workspace, slot, manager, starting, booted: false, users: 0, lastReleasedAt: 0 };
    this.guests.set(workspace, guest);
    starting.then(() => { guest.booted = true; }, () => {
      if (this.guests.get(workspace) === guest) this.guests.delete(workspace);
      if (!this.closed) this.freeSlots.push(slot);
      this.wake();
    });
    return guest;
  }

  private async lease(guest: Guest): Promise<GuestLease> {
    guest.users++;
    try {
      await guest.starting;
    } catch (error) {
      guest.users--;
      throw error;
    }
    let released = false;
    return {
      workspace: guest.workspace,
      manager: guest.manager,
      release: () => {
        if (released) return;
        released = true;
        guest.users--;
        guest.lastReleasedAt = performance.now();
        this.wake();
      },
    };
  }

  private nextRelease(signal?: AbortSignal): Promise<void> {
    return new Promise((resolveWait) => {
      const done = (): void => {
        signal?.removeEventListener("abort", done);
        resolveWait();
      };
      this.waiters.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private assertOpen(signal?: AbortSignal): void {
    if (this.closed) throw new Error("BoxLite guest pool is closed.");
    if (signal?.aborted) throw new Error("Guest acquisition cancelled.");
  }
}

async function stopGuest(guest: Guest): Promise<void> {
  try {
    const active = await guest.starting;
    await active.close();
  } catch {
    // The guest never came up; nothing to tear down.
  }
}
