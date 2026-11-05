import type { AgentRun, CollaborationRoundManifest, RelaySession } from "relay-core";

export type DirectDelegationStatus = "queued" | "working" | "returned" | "resuming" | "reported_done" | "needs_attention" | "cancelled";
export type DirectDelegationView = NonNullable<CollaborationRoundManifest["delegation"]> & {
  requesterRunId?: string;
  child?: AgentRun;
  status: DirectDelegationStatus;
};

export function directDelegations(session?: RelaySession | null): DirectDelegationView[] {
  if (!session) return [];
  const latestRun = (id: string) => session.agentRuns.filter((run) => run.assignmentId === id).at(-1);
  const executing = (run: AgentRun) => Boolean(run.agentLog) || session.events.some((event) =>
    (event.type === "collaboration.delivery" && event.assignmentId === run.assignmentId && event.status === "running")
    || (event.type === "agent.output" && event.runId === run.id && Boolean(event.text)));
  return (session.collaborationRounds ?? []).flatMap((round) => {
    const receipt = round.delegation;
    if (!receipt) return [];
    const child = latestRun(receipt.childAssignmentId);
    const resume = latestRun(receipt.resumeAssignmentId);
    let status: DirectDelegationStatus = "queued";
    if (resume && resume.status !== "running") {
      status = resume.status === "completed" && resume.workResult?.status === "done" && resume.workResult.evidence.length > 0
        ? "reported_done" : "needs_attention";
    } else if (session.status === "cancelled") status = "cancelled";
    else if (resume && executing(resume)) status = "resuming";
    else if (child && child.status !== "running") status = "returned";
    else if (child && executing(child)) status = "working";
    else if (session.status === "failed") status = "needs_attention";
    return [{ ...receipt, requesterRunId: latestRun(receipt.requesterAssignmentId)?.id, child, status }];
  });
}
