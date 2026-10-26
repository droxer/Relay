import type { RelaySession, RelayTaskListItem } from "../types.js";
import { waitsOnPrerequisites } from "./taskPrerequisites.ts";

/**
 * Why a task is not simply moving — as data, not as markup.
 *
 * The board card used to derive all of this inline and every other surface
 * would have derived it a second time, which is how two surfaces end up
 * disagreeing about whether a task is blocked. The tile and the row state
 * only the hold-up (`taskHoldup`); the record reads the rest.
 *
 * Kept pure and free of `t()`: an unknown blocker resolves to a translation
 * key at the call site, not here.
 */

/** What `task-store` writes as the reason when the agent recorded none. */
export const UNKNOWN_BLOCKER_SENTINEL = "Execution needs attention.";

/** Session phases that mean the run is proceeding, not recovering. */
const SETTLED_EXECUTION_PHASES = ["running", "terminal"];

type TaskException =
  /** The session behind this task is reconciling rather than running. */
  | { kind: "recovering"; phase: string }
  /** `unknown` means nobody recorded why — render the recovery copy, not a blank reason. */
  | { kind: "blocked"; unknown: boolean; reason: string | null }
  | { kind: "waiting" }
  /** Days the work has been in flight, for work still in flight. */
  | { kind: "age"; days: number };

/** Days since the task started, for work still in flight. */
export function taskWorkAgeDays(task: RelayTaskListItem): number | null {
  if (!task.startedAt || task.status === "done") return null;
  const started = Date.parse(task.startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, (Date.now() - started) / 86400000);
}

/**
 * The blocker as recorded: the attention summary when there is one, the raw
 * reason otherwise, and `unknown` when the record says the agent stopped
 * without saying why.
 */
export function taskBlocker(task: RelayTaskListItem): { unknown: boolean; reason: string | null } {
  if (task.attention?.evidence === "unknown" || task.blockerReason === UNKNOWN_BLOCKER_SENTINEL) {
    return { unknown: true, reason: null };
  }
  const reason = task.attention?.summary || task.blockerReason || "";
  return { unknown: false, reason: reason.trim() ? reason : null };
}

/**
 * Every exception worth stating about this task, in the order a reader wants
 * them: what is happening to the run, then why it stopped, then how long it
 * has been going. An empty array means there is nothing to draw — an empty
 * exception row still carries its own margin.
 */
export function taskExceptions(
  task: RelayTaskListItem,
  execution: RelaySession["execution"] | undefined,
): TaskException[] {
  const exceptions: TaskException[] = [];
  if (execution && !SETTLED_EXECUTION_PHASES.includes(execution.phase)) {
    exceptions.push({ kind: "recovering", phase: execution.phase });
  }
  if (task.status === "blocked") exceptions.push({ kind: "blocked", ...taskBlocker(task) });
  if (task.status === "waiting_for_human") exceptions.push({ kind: "waiting" });
  const days = taskWorkAgeDays(task);
  if (days !== null) exceptions.push({ kind: "age", days });
  return exceptions;
}

/**
 * What a task is held up on, for the one-line summary every list surface
 * shows beside its title: a blocker, or the question a person owes it. Null
 * for a task that is simply moving. `text` is null when nothing was recorded;
 * the caller renders its own copy for that rather than a bare label.
 */
export type TaskHoldup =
  | { kind: "blocked"; text: string | null }
  | { kind: "waiting"; text: string | null }
  /** Ready work the scheduler holds until these prerequisites are done. */
  | { kind: "prerequisites"; ids: string[] };

export function taskHoldup(task: RelayTaskListItem): TaskHoldup | null {
  if (task.status === "blocked") return { kind: "blocked", text: taskBlocker(task).reason };
  if (task.status === "waiting_for_human") return { kind: "waiting", text: task.awaiting?.text?.trim() || null };
  if (waitsOnPrerequisites(task)) return { kind: "prerequisites", ids: task.waitingOn ?? [] };
  return null;
}
