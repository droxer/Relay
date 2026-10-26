import type { DefaultAgentOffer } from "../api-client/agents.ts";
import { AGENT_NAMES, type AgentName } from "../types.ts";

/**
 * The offer to ask about now: the first computer the person has not set
 * aside this session, keeping only runtimes this build can name. Setting an
 * offer aside (closing the dialog) is not an answer — it comes back on the
 * next load; only Create and Skip are remembered, server-side.
 */
export function nextDefaultAgentOffer(
  offers: readonly DefaultAgentOffer[],
  setAside: ReadonlySet<string>,
): DefaultAgentOffer | null {
  for (const offer of offers) {
    if (setAside.has(offer.computerId)) continue;
    const executorKinds = AGENT_NAMES.filter((kind) => offer.executorKinds.includes(kind));
    if (executorKinds.length > 0) return { ...offer, executorKinds };
  }
  return null;
}

/** An answer covers every offered runtime: the checked ones are created, the
    rest declined, so the question is not asked again for either. */
export function splitDefaultAgentAnswer(
  offer: DefaultAgentOffer,
  selected: ReadonlySet<AgentName>,
): { accept: AgentName[]; decline: AgentName[] } {
  return {
    accept: offer.executorKinds.filter((kind) => selected.has(kind)),
    decline: offer.executorKinds.filter((kind) => !selected.has(kind)),
  };
}
