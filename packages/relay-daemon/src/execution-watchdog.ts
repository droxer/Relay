export interface ExecutionWatchdogOptions {
  /** How long an expired lease may run on while the backend is unreachable. */
  graceMs?: number;
  /** True while the backend cannot be reached (network/5xx), not when it refuses. */
  shouldGrace?: () => boolean;
  onGrace?: (id: string) => void;
}

/** A run loses permission to execute when its own lease stops renewing. */
export class ExecutionWatchdog {
  private readonly leases = new Map<string, { deadline: number; observedAt: number; graced: boolean; stop: () => void }>();
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly options: ExecutionWatchdogOptions = {},
  ) {}
  track(id: string, durationMs: number, stop: () => void): void {
    this.leases.set(id, { deadline: this.now() + Math.max(0, durationMs), observedAt: -Infinity, graced: false, stop });
  }
  renew(id: string, durationMs: number, observedAt?: number): void {
    const lease = this.leases.get(id);
    if (!lease || (observedAt !== undefined && observedAt < lease.observedAt)) return;
    // Poll and heartbeat responses can arrive out of order. Only newer server
    // observations may replace confirmed ownership, including shortening it.
    if (observedAt !== undefined) lease.observedAt = observedAt;
    lease.deadline = this.now() + Math.max(0, durationMs);
    lease.graced = false;
  }
  forget(id: string): void { this.leases.delete(id); }
  tick(): void {
    const unreachable = this.options.shouldGrace?.() ?? false;
    for (const [id, lease] of this.leases) {
      // A backend outage is not a revocation, so one grace period carries the
      // run through it. Once the backend answers without renewing the lease,
      // ownership is gone and the grace ends with it.
      if (lease.graced && !unreachable) {
        this.stop(id, lease);
        continue;
      }
      if (this.now() < lease.deadline) continue;
      const graceMs = this.options.graceMs ?? 0;
      if (!lease.graced && graceMs > 0 && unreachable) {
        lease.graced = true;
        lease.deadline = this.now() + graceMs;
        this.options.onGrace?.(id);
        continue;
      }
      this.stop(id, lease);
    }
  }
  private stop(id: string, lease: { stop: () => void }): void {
    this.leases.delete(id);
    lease.stop();
  }
}
