import type { AgentName, RelaySession } from "../types.js";
import { labelForAgentRun } from "./agentDisplayNames.ts";

/**
 * The agent the thread header names for this thread.
 *
 * It is a fact about the thread, so it names the agent that last ran in
 * it — resolved from the run's logical id, never the executor kind. The
 * composer's current selection is only the answer for a thread with no runs
 * yet: it is who will answer next, and it drifts away from the thread's own
 * agent whenever that agent is not routable, which relabelled a transcript
 * Analyst wrote as "Builder".
 */
export function threadAgentName(
  session: Pick<RelaySession, "agentRuns">,
  composerAgentName: string | undefined,
  logicalAgentNames?: Record<string, string>,
  agentDisplayNames?: Partial<Record<AgentName, string>>,
): string | undefined {
  const lastRun = session.agentRuns?.at(-1);
  if (!lastRun) return composerAgentName;
  return labelForAgentRun({ agent: lastRun.agent, agentId: lastRun.logicalAgentId }, logicalAgentNames, agentDisplayNames);
}
