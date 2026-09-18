import type { RelaySession } from "../types.js";

type WorkItem = NonNullable<NonNullable<RelaySession["collaborationRounds"]>[number]["workGraph"]>["items"][number];
export type CollaborationWorkView = WorkItem & {
  status: "stale" | "pending" | "running" | "blocked" | "unverified" | "accepted" | "needs_changes";
  result: RelaySession["agentRuns"][number]["workResult"];
  messages: NonNullable<NonNullable<RelaySession["agentRuns"][number]["workResult"]>["messages"]>;
};

export function deriveCollaborationWork(session: RelaySession | undefined): CollaborationWorkView[] {
  const items = session?.collaborationRounds?.at(-1)?.workGraph?.items ?? [];
  const runs = session?.agentRuns ?? [];
  const latest = new Map<string, number>();
  runs.forEach((run, index) => { if (run.assignmentId && !run.consultation) latest.set(run.assignmentId, index); });
  return items.map(item => {
    const index = (latest.get(item.assignmentId) ?? -1);
    const run = index >= 0 ? runs[index] : undefined;
    const stale = index >= 0 && item.dependsOnWorkItemIds.some(id => {
      const predecessor = items.find(candidate => candidate.workItemId === id);
      return predecessor && (latest.get(predecessor.assignmentId) ?? -1) > index;
    });
    const status = stale ? "stale"
      : !run ? "pending"
      : run.status === "running" ? "running"
      : run.status !== "completed" ? "blocked"
      : !run.workResult ? "unverified"
      : run.workResult.status === "done" && run.workResult.evidence.length ? "accepted"
      : run.workResult.status === "continue" ? "needs_changes" : "blocked";
    const messages = runs.filter(attempt => attempt.assignmentId === item.assignmentId)
      .flatMap(attempt => attempt.workResult?.messages ?? []).slice(-50);
    return { ...item, status, result: run?.workResult, messages };
  });
}
