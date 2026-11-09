/** Hysteresis for the shared report quota and the physical filesystem. */
export class ReportStoragePolicy {
  private protected = false;
  private stopping = false;
  constructor(private readonly freeAdmissionBytes = 256 * 1024 ** 2,
    private readonly freeStopBytes = 128 * 1024 ** 2, private readonly freeResumeBytes = 512 * 1024 ** 2) {
    if (!(freeStopBytes > 0 && freeStopBytes < freeAdmissionBytes && freeAdmissionBytes < freeResumeBytes)) throw new RangeError('Report free-space thresholds must satisfy stop < admission < resume.');
  }
  update(input: { bytes: number; limitBytes: number; freeBytes: number; online: boolean; persistenceFault: boolean }): { admit: boolean; stop: boolean } {
    const fraction = input.bytes / input.limitBytes;
    if (fraction >= 0.8 || input.freeBytes < this.freeAdmissionBytes || input.persistenceFault) this.protected = true;
    if (fraction >= 0.9 || input.freeBytes < this.freeStopBytes || input.persistenceFault) { this.protected = true; this.stopping = true; }
    if (fraction < 0.5 && input.freeBytes >= this.freeResumeBytes && input.online && !input.persistenceFault) {
      this.protected = false;
      this.stopping = false;
    }
    return { admit: !this.protected, stop: this.stopping };
  }
}
