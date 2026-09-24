import type { AgentRun, CollaborationRoundManifest, CollaborationStyle, RelaySession } from "relay-core";

// Mirrors backend/relay/collaboration/styles.py. Keep role precedence in sync.
export const COLLABORATION_STYLES: readonly CollaborationStyle[] = ["build_review", "solo", "pipeline", "lead_led"];
export const DEFAULT_COLLABORATION_STYLE: CollaborationStyle = "build_review";
const STAGE: Record<string, number> = { planner: 0, implementer: 1, fixer: 1, tester: 2, reviewer: 3 };
export interface SlotMember { id: string; role?: string; onRequest?: boolean }
type Slot = { slot: "builder" | "reviewer" | "member" | "lead"; memberId: string };

export function effectiveStyle(team?: { collaborationStyle?: CollaborationStyle }, taskStyle?: CollaborationStyle | null): CollaborationStyle {
  return taskStyle ?? team?.collaborationStyle ?? DEFAULT_COLLABORATION_STYLE;
}

export function previewSlots(all: SlotMember[], leadId: string | undefined, style: CollaborationStyle): { style: CollaborationStyle; fallbackFrom?: CollaborationStyle; slots: Slot[] } {
  const members = all.filter((m) => !m.onRequest || m.id === leadId);
  if (!members.length) return { style, slots: [] };
  const ordered = [...members].sort((a, b) => (STAGE[a.role ?? ""] ?? 1) - (STAGE[b.role ?? ""] ?? 1));
  const lead = members.find((m) => m.id === leadId);
  if (style === "pipeline") return { style, slots: ordered.map((m) => ({ slot: "member", memberId: m.id })) };
  if (style === "lead_led") {
    const rest = ordered.filter((m) => m.id !== leadId).map((m): Slot => ({ slot: "member", memberId: m.id }));
    const first: Slot[] = lead ? [{ slot: "lead", memberId: lead.id }] : [];
    return { style, slots: [...first, ...rest, ...(rest.length ? first : [])] };
  }
  const builds = (m: SlotMember) => m.role === "implementer" || m.role === "fixer";
  const builder = (lead && builds(lead) ? lead : undefined) ?? members.find(builds) ?? lead ?? members[0];
  const others = members.filter((m) => m.id !== builder.id);
  const reviewer = others.find((m) => m.role === "reviewer") ?? others.find((m) => m.role === "tester") ?? others.find((m) => m.id === leadId) ?? others[0];
  if (style === "solo" || !reviewer) return {
    style: "solo", ...(style === "build_review" ? { fallbackFrom: "build_review" as const } : {}),
    slots: [{ slot: "builder", memberId: builder.id }],
  };
  return { style, slots: [{ slot: "builder", memberId: builder.id }, { slot: "reviewer", memberId: reviewer.id }] };
}

export function styleForRun(run: Pick<AgentRun, "assignmentId" | "teamSnapshot">, rounds: CollaborationRoundManifest[] = []): CollaborationStyle | undefined {
  if (run.teamSnapshot?.collaborationStyle) return run.teamSnapshot.collaborationStyle;
  const round = rounds.find((r) => r.assignments.some((a) => a.assignmentId === run.assignmentId));
  return round?.style ?? (round?.teamSnapshot || run.teamSnapshot ? "lead_led" : undefined);
}

export function turnSlot(run: { role?: string; coordinator?: boolean; synthesizer?: boolean; workResult?: { status?: string; findings?: unknown[] } }, style?: CollaborationStyle): string | null {
  if (!style) return null;
  if (style === "lead_led" && run.coordinator) return "lead";
  if (style === "lead_led" && run.synthesizer) return "lead_summary";
  if (run.role === "reviewer") {
    if (run.workResult?.status === "continue" && run.workResult.findings?.length) return "reviewer_changes";
    if (run.workResult?.status === "done") return "reviewer_approved";
    return "reviewer";
  }
  if (run.role === "implementer" || run.role === "fixer") return "builder";
  return run.role === "planner" || run.role === "tester" ? run.role : null;
}

export function reviewCycle(session: RelaySession): { cycle: number; max: number } | null {
  const round = session.collaborationRounds?.find((r) => r.roundId === session.activeRoundId) ?? session.collaborationRounds?.at(-1);
  if (session.status !== "running" || round?.style !== "build_review") return null;
  const builder = round.assignments.find((a) => a.role === "implementer");
  if (!builder) return null;
  const cycle = (session.agentRuns ?? []).filter((r) => r.assignmentId === builder.assignmentId && !r.consultation).length;
  return cycle > 1 ? { cycle, max: 3 } : null;
}

export function reviewBudgetExhausted(session: RelaySession): boolean {
  const round = session.collaborationRounds?.at(-1);
  if (round?.style !== "build_review" || session.workOutcome !== "blocked") return false;
  const reviewer = round.assignments.find((a) => a.role === "reviewer");
  const reviews = (session.agentRuns ?? []).filter((r) => r.assignmentId === reviewer?.assignmentId && !r.consultation);
  const last = reviews.at(-1)?.workResult;
  return reviews.length >= 3 && last?.status === "continue" && Boolean(last.findings?.length);
}
