import { uptime } from "node:os";

/**
 * Proving that a run admitted before a daemon restart is no longer executing.
 *
 * A journaled run is never resumed, but "not resumed" is not "not running": a
 * host process group or a BoxLite guest can outlive the daemon. Only evidence
 * from the machine itself may settle such a run; anything short of proof
 * leaves it for a person to report gone.
 */

/** What the journal knows about where a run executed. */
export interface ExecutionEvidence {
  /** Process group id of a host-mode run (its leader's pid). */
  processGroup?: number;
  /** When the host booted, in epoch ms, as seen when the run spawned. */
  bootAt?: number;
}

// os.uptime() has second granularity and the clock may be nudged, so two reads
// of the same boot differ slightly. A reboot moves it by far more.
const BOOT_SKEW_MS = 120_000;

export function hostBootAt(now = Date.now(), upSeconds = uptime()): number {
  return Math.round(now - upSeconds * 1000);
}

/**
 * Probe-only by design: after a restart the recorded id may name an unrelated
 * process group, so the daemon never signals it, it only looks.
 */
export function localExitProven(
  evidence: ExecutionEvidence,
  probe: (processGroup: number) => unknown = (group) => process.kill(-group, 0),
  currentBootAt = hostBootAt(),
): boolean {
  if (!evidence.processGroup || evidence.bootAt === undefined) return false;
  if (Math.abs(currentBootAt - evidence.bootAt) > BOOT_SKEW_MS) return true;
  try {
    probe(evidence.processGroup);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export interface GuestRuntime {
  listInfo(): Promise<Array<{ name?: string }>>;
  remove(name: string, force?: boolean): Promise<unknown>;
}

/**
 * Force-remove the guests a previous daemon left for this computer, then
 * confirm none remain. Those guests ran only fenced runs, and the next boot of
 * any slot would remove its same-named box anyway.
 */
export async function retireStaleGuests(runtime: GuestRuntime, baseName: string): Promise<boolean> {
  const slot = new RegExp(`^${escapeRegExp(baseName)}-\\d+$`);
  const ours = (name?: string): name is string =>
    name === baseName || (name !== undefined && slot.test(name));
  for (const { name } of await runtime.listInfo()) {
    if (ours(name)) await runtime.remove(name, true).catch(() => undefined);
  }
  return !(await runtime.listInfo()).some(({ name }) => ours(name));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
