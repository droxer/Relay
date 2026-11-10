/** Sample locally each second, but only send useful diagnostics to the backend. */
export class DiagnosticsSchedule {
  private last?: { at: number; health: string; activity: string };

  private keys(snapshot: Record<string, unknown>): { health: string; activity: string } {
    return {
      health: JSON.stringify([snapshot.state, snapshot.causes, snapshot.incident, snapshot.recovered,
        snapshot.quarantined, snapshot.corrupt, snapshot.persistenceFault, snapshot.quotaExceeded, snapshot.verified]),
      activity: JSON.stringify([snapshot.pending, snapshot.runs]),
    };
  }

  due(snapshot: Record<string, unknown>, now: number): boolean {
    if (!this.last) return true;
    const keys = this.keys(snapshot);
    if (keys.health !== this.last.health) return true;
    const elapsed = now - this.last.at;
    // Recovery needs repeated observations to establish ten seconds of health
    // and forward progress. Once settled, healthy snapshots are much quieter.
    const recovering = !!snapshot.incident && snapshot.recovered !== true;
    return elapsed >= (recovering ? 5000 : 30_000)
      || (keys.activity !== this.last.activity && elapsed >= 5000);
  }

  sent(snapshot: Record<string, unknown>, now: number): void {
    this.last = { at: now, ...this.keys(snapshot) };
  }
}
