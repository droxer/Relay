/** A run loses permission to execute when its own lease stops renewing. */
export class ExecutionWatchdog {
  private readonly leases = new Map<string, { deadline: number; stop: () => void }>();
  constructor(private readonly now: () => number = () => performance.now()) {}
  track(id: string, durationMs: number, stop: () => void): void {
    this.leases.set(id, { deadline: this.now() + Math.max(0, durationMs), stop });
  }
  renew(id: string, durationMs: number): void {
    const lease = this.leases.get(id);
    if (lease) lease.deadline = this.now() + Math.max(0, durationMs);
  }
  forget(id: string): void { this.leases.delete(id); }
  tick(): void {
    for (const [id, lease] of this.leases) {
      if (this.now() >= lease.deadline) {
        this.leases.delete(id);
        lease.stop();
      }
    }
  }
}
