import type { AgentName, RelaySession } from "../types.js";
import { labelForAgentRun } from "./agentDisplayNames.ts";

/**
 * A thread's coordinates.
 *
 * Every other record surface — agent, team, task, project — prints a facts
 * band under its header, and a thread was the one record whose facts lived
 * nowhere addressable: which project it belongs to, which agent answers in
 * it, which computer runs it, when it last moved. The project was the
 * sharpest loss — the space panel browsed a project workspace while the
 * thread never named the project or offered a way back to it.
 *
 * Descriptors, not rendered cells: the words belong to the translation
 * catalogue and the project fact has to become a link, which a string cannot.
 */
export type ThreadBandFact =
  | { key: "project"; projectId: string; name: string }
  | { key: "agent"; name: string }
  | { key: "computer"; id: string; name: string }
  | { key: "updated"; iso: string };

export type ThreadBandContext = {
  /** The project's name, when the projects collection has resolved it. */
  projectName?: string;
  /** The agent answering in this thread, already resolved to a display name. */
  agentName?: string;
  /** The computer's display name, when the node is known to this client. */
  computerName?: string;
};

export function threadBandFacts(
  session: RelaySession,
  { projectName, agentName, computerName }: ThreadBandContext,
): ThreadBandFact[] {
  const facts: ThreadBandFact[] = [];
  if (session.projectId) {
    // An id is a poor name but a real coordinate — better than dropping the
    // one fact that leads back to the project while its name is in flight.
    facts.push({ key: "project", projectId: session.projectId, name: projectName || session.projectId });
  }
  if (agentName) facts.push({ key: "agent", name: agentName });
  if (session.computerId) {
    facts.push({ key: "computer", id: session.computerId, name: computerName || session.computerId });
  }
  facts.push({ key: "updated", iso: session.updatedAt });
  return facts;
}

/**
 * The agent the band names for this thread.
 *
 * The band is a fact about the thread, so it names the agent that last ran in
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
