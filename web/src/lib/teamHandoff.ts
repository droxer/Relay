import type { AgentName, RelaySession } from "../types.js";

type Round = NonNullable<RelaySession["collaborationRounds"]>[number];
type Run = RelaySession["agentRuns"][number];
type WorkResult = NonNullable<Run["workResult"]>;

/**
 * Where the round goes after the turn that just ended:
 * - `handoff`: a named teammate runs next;
 * - `closing`: no further turn — the round is being wrapped up;
 * - `open`: a next turn may come, but its owner cannot be read off the round.
 */
type HandoffPhase = "handoff" | "closing" | "open";

interface TeamHandoff {
  /** Run that ended — identifies this gap. */
  fromRunId: string;
  /** Logical agent that just finished; absent on legacy runs. */
  fromAgentId: string | undefined;
  fromAgent: AgentName;
  phase: HandoffPhase;
  /** Teammate the round advances to; set only in the `handoff` phase — the
   * conductor decides, and a wrong name is worse than none. */
  toAgentId: string | null;
  /** How the previous turn ended. A failed turn the thread keeps running
   * through is being repaired or skipped, not handed on as done work. */
  outcome: "completed" | "failed";
  /** When the previous turn ended — the start of the quiet gap. */
  since: string | undefined;
}

type Step = { phase: "handoff"; agentId: string } | { phase: "closing" } | { phase: "open" };

const CLOSING: Step = { phase: "closing" };
const OPEN: Step = { phase: "open" };

// Mirrors of the conductor's limits (backend/relay/collaboration/work.py,
// policy.py). Keep them in step.
const MAX_CONSULTATIONS = 2;
const MAX_WORK_REPAIRS = 2;
const INSPECTING_STYLES: ReadonlySet<string> = new Set(["build_review", "pipeline", "lead_led"]);
const REPAIRABLE_KINDS: ReadonlySet<string> = new Set(["implementation", "repair"]);

/** One assignment with the work-item fields the conductor routes on. */
interface Slot {
  agentId: string;
  assignmentId: string;
  /** Like the backend, an item id falls back to the assignment id. */
  workItemId: string;
  workKind: string | undefined;
  required: boolean;
  mode: "action" | "ask" | "review";
  coordinator: boolean;
}

/**
 * The quiet gap in a team round between one member's turn ending and the
 * next member's run appearing. Nothing streams during it — and it lasts
 * whenever the computer has no free slot — so without a cue the thread reads
 * as stuck. Once the next run is staged its own turn takes over.
 */
export function deriveTeamHandoff(session: RelaySession | null | undefined): TeamHandoff | null {
  if (!session || session.status !== "running") return null;
  const round = session.collaborationRounds?.find((item) => item.roundId === session.activeRoundId);
  if (!round || round.assignments.length < 2) return null;
  const runs = session.agentRuns ?? [];
  if (runs.some((item) => item.status === "running")) return null;

  // A lead plan's round keeps the coordinator's assignment id, so its
  // planning turn counts as this round's first run.
  const assignmentIds = new Set(round.assignments.map((item) => item.assignmentId));
  const roundRuns = runs.filter((item) => item.assignmentId && assignmentIds.has(item.assignmentId));
  const last = roundRuns.at(-1);
  if (!last || (last.status !== "completed" && last.status !== "failed")) return null;

  const step = last.status === "completed" ? nextStep(round, roundRuns, last) : OPEN;
  return {
    fromRunId: last.id,
    fromAgentId: last.logicalAgentId,
    fromAgent: last.agent,
    phase: step.phase,
    toAgentId: step.phase === "handoff" ? step.agentId : null,
    outcome: last.status,
    since: last.completedAt,
  };
}

function slotsOf(round: Round): Slot[] {
  const items = new Map((round.workGraph?.items ?? []).map((item) => [item.assignmentId, item]));
  return round.assignments.map((assignment) => {
    const item = items.get(assignment.assignmentId);
    return {
      agentId: assignment.agentId,
      assignmentId: assignment.assignmentId,
      workItemId: item?.workItemId ?? assignment.assignmentId,
      workKind: item?.kind,
      required: item?.required ?? true,
      mode: assignment.mode ?? "action",
      coordinator: assignment.coordinator === true,
    };
  });
}

const handoffTo = (slot: Slot | undefined): Step => (slot ? { phase: "handoff", agentId: slot.agentId } : CLOSING);

/**
 * Read the next turn off the same rules the backend conductor applies after a
 * successful turn (policy.py `next_work_transition`): a consultation answer
 * resumes its asker, a question consults an earlier teammate, findings send
 * work back to the earliest cited implementation item, and a required turn
 * without a `done` report ends the round. Consultation and repair budgets are
 * counted from this round's runs; when the outcome still depends on state the
 * thread does not carry, the target stays open.
 */
function nextStep(round: Round, roundRuns: Run[], last: Run): Step {
  const slots = slotsOf(round);
  const index = slots.findIndex((slot) => slot.assignmentId === last.assignmentId);
  if (index < 0) return OPEN;
  if (last.consultation) return afterConsultation(slots, roundRuns, last);

  const slot = slots[index]!;
  const inOrder = handoffTo(slots[index + 1]);
  const result = last.workResult;
  if (!result) {
    // A member may finish without a report; inspecting styles let the next
    // member look at the workspace instead.
    const style = last.teamSnapshot?.collaborationStyle ?? round.teamSnapshot?.collaborationStyle ?? round.style;
    const mayInspect = index + 1 < slots.length && Boolean(style && INSPECTING_STYLES.has(style)) && !slot.coordinator;
    if (!slot.required || mayInspect) return inOrder;
    // Only a daemon that reports work results gates the round on them; an
    // older one advances in order. Without a report anywhere in the round
    // there is no telling which this is.
    if (roundRuns.some((item) => item.workResult)) return CLOSING;
    return inOrder.phase === "closing" ? CLOSING : OPEN;
  }

  const consulted = consultationTarget(slots, index, result, roundRuns);
  if (consulted) return consulted;
  const repair = repairTarget(slots, index, result, roundRuns);
  if (repair) return repair;
  if (result.status !== "done") return slot.required ? CLOSING : inOrder;
  if (isPlanningTurn(round, slot, index, roundRuns)) return afterPlanningTurn(result);
  return inOrder;
}

/** A done answer turn resumes its asker when it names the asker's work item
 * or leaves the sole open question's recipient implicit. */
function afterConsultation(slots: Slot[], roundRuns: Run[], last: Run): Step {
  const result = last.workResult;
  const answers = (result?.messages ?? []).filter((message) => message.kind === "answer");
  // The consultation is staged straight after the turn that asked.
  const asker = roundRuns.slice(0, roundRuns.indexOf(last)).reverse().find((item) => !item.consultation);
  const requester = asker
    ? slots.find((slot) => slot.assignmentId === asker.assignmentId)
    : slots.find((slot) => answers.some((message) => message.toWorkItemId === slot.workItemId));
  if (!requester || result?.status !== "done") return CLOSING;
  return answers.some((message) => !message.toWorkItemId || message.toWorkItemId === requester.workItemId)
    ? handoffTo(requester) : CLOSING;
}

/** A question consults only a teammate earlier in the round, and only from a
 * turn that is not `done`, while the round's consultation budget lasts. */
function consultationTarget(slots: Slot[], index: number, result: WorkResult, roundRuns: Run[]): Step | null {
  if (result.status !== "continue" && result.status !== "blocked") return null;
  if (roundRuns.filter((item) => item.consultation).length >= MAX_CONSULTATIONS) return null;
  for (const message of result.messages ?? []) {
    if (message.kind !== "question") continue;
    const target = slots.slice(0, index).find((slot) => slot.workItemId === message.toWorkItemId);
    if (target) return handoffTo(target);
  }
  return null;
}

/** Findings reopen work only when every one cites an earlier action-mode
 * implementation or repair item; the earliest of them runs next. */
function repairTarget(slots: Slot[], index: number, result: WorkResult, roundRuns: Run[]): Step | null {
  if (result.status !== "continue" || !result.findings?.length) return null;
  const targets = result.findings.map((finding) => slots.slice(0, index).findIndex((slot) =>
    slot.workItemId === finding.workItemId
    && slot.workKind !== undefined
    && REPAIRABLE_KINDS.has(slot.workKind)
    && slot.mode === "action"));
  if (targets.some((target) => target < 0)) return null;
  // The budget is spent by every step back the round already took — work
  // repairs and coordinator runtime repairs alike.
  if (stepsBack(slots, roundRuns) >= MAX_WORK_REPAIRS) return null;
  return handoffTo(slots[Math.min(...targets)]);
}

/** Times the round moved to an earlier assignment. A resumed asker returns to
 * its own position, and consultations sit outside the order. */
function stepsBack(slots: Slot[], roundRuns: Run[]): number {
  const positions = roundRuns
    .filter((item) => !item.consultation)
    .map((item) => slots.findIndex((slot) => slot.assignmentId === item.assignmentId));
  return positions.filter((position, at) => at > 0 && position < positions[at - 1]!).length;
}

/** The coordinator's first turn in its own round plans the rest; a lead
 * plan's round has already adopted that plan, and a rerun is a repair. */
function isPlanningTurn(round: Round, slot: Slot, index: number, roundRuns: Run[]): boolean {
  if (index !== 0 || !slot.coordinator || round.parentRoundId || round.source === "lead_plan") return false;
  return roundRuns.filter((item) => !item.consultation && item.assignmentId === slot.assignmentId).length === 1;
}

/** The plan's first item runs next, and no plan ends the round on a plan
 * error. An empty plan still compiles to the closing synthesis turn unless
 * it omits required work — which only the conductor can judge. */
function afterPlanningTurn(result: WorkResult): Step {
  const plan = (result as WorkResult & { plan?: Array<{ agentId?: unknown }> }).plan;
  if (!Array.isArray(plan)) return CLOSING;
  const owner = plan[0]?.agentId;
  return typeof owner === "string" ? { phase: "handoff", agentId: owner } : OPEN;
}
