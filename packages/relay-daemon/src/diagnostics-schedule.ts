/** Sample locally each second, but only send useful diagnostics to the backend. */
export class DiagnosticsSchedule {
  private failures = 0;
  private retryAt = 0;
  private warnedAt = -Infinity;
  private last?: { at: number; health: string };

  private health(snapshot: Record<string, unknown>): string {
    return JSON.stringify([snapshot.state, snapshot.causes, snapshot.incident, snapshot.recovered,
      Boolean(snapshot.quarantined), Boolean(snapshot.corrupt), snapshot.persistenceFault, snapshot.quotaExceeded, snapshot.verified]);
  }

  due(snapshot: Record<string, unknown>, now: number): boolean {
    if (now < this.retryAt) return false;
    if (!this.last) return true;
    if (this.health(snapshot) !== this.last.health) return true;
    const elapsed = now - this.last.at;
    // Recovery needs repeated observations to establish ten seconds of health
    // and forward progress. Once settled, healthy snapshots are much quieter.
    const recovering = !!snapshot.incident && snapshot.recovered !== true && snapshot.state === "healthy"
      && Array.isArray(snapshot.causes) && snapshot.causes.length === 0;
    return elapsed >= (recovering ? 5000 : 30_000);
  }

  /** Return whether this failure merits a warning; failed delivery never marks a snapshot sent. */
  failed(now: number, retryAfterMs = 0): boolean {
    this.failures++;
    this.retryAt = now + Math.max(retryAfterMs, Math.min(60_000, 5000 * 2 ** Math.min(this.failures - 1, 4)));
    if (now - this.warnedAt < 30_000) return false;
    this.warnedAt = now;
    return true;
  }

  sent(snapshot: Record<string, unknown>, now: number): void {
    this.failures = 0;
    this.retryAt = 0;
    this.warnedAt = -Infinity;
    this.last = { at: now, health: this.health(snapshot) };
  }
}
