import type { RelaySession } from "../types.js";

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
