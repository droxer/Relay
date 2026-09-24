import type { AgentName, ThreadMessageInput } from "../types.js";
import { parseMentions, type MentionCandidate } from "./mentions.ts";

export type RoutedComposerMessage = {
  agentId: string;
  agent: AgentName;
  goal: string;
};

/** Build a message for the agent selected in the composer footer. */
export function routeComposerMessage(
  raw: string,
  activeAgent: { id: string; executorKind: AgentName },
): RoutedComposerMessage {
  return {
    agentId: activeAgent.id,
    agent: activeAgent.executorKind,
    goal: raw.trim(),
  };
}

export type ThreadMessageAddress = {
  blocked: boolean;
  reason?: "mention" | "selected-agent";
  addressAgentIds: string[];
};

/**
 * Resolve exactly who a composer message addresses.
 *
 * A leading mention wins over the footer selection. Omitting
 * `defaultAgentId` intentionally addresses the room (for example, a team
 * thread). Supplying a null, unknown, or unavailable selection blocks rather
 * than silently widening the message to the room.
 */
export function resolveThreadMessageAddress({ text, candidates, defaultAgentId }: {
  text: string;
  candidates: readonly MentionCandidate[];
  defaultAgentId?: string | null;
}): ThreadMessageAddress {
  const parsed = parseMentions(text, candidates);
  if (parsed.blocked) {
    return { blocked: true, reason: "mention", addressAgentIds: [] };
  }
  if (parsed.addressAgentIds.length) {
    return { blocked: false, addressAgentIds: parsed.addressAgentIds };
  }
  if (defaultAgentId === undefined) {
    return { blocked: false, addressAgentIds: [] };
  }
  const selectedCandidate = candidates.find(
    (candidate) => candidate.id === defaultAgentId && candidate.eligible,
  );
  if (!selectedCandidate) {
    return { blocked: true, reason: "selected-agent", addressAgentIds: [] };
  }
  return { blocked: false, addressAgentIds: [selectedCandidate.id] };
}

/** Stable retry identity for one semantic continued-thread request. */
export function threadMessageOperationKey({ sessionId, text, intent, addressAgentIds, addressTeamId = null }: {
  sessionId: string;
  text: string;
  intent: ThreadMessageInput["intent"];
  addressAgentIds: readonly string[];
  /** Aiming the same text at another team is a different request. */
  addressTeamId?: string | null;
}): string {
  return JSON.stringify([
    sessionId,
    text,
    intent,
    [...new Set(addressAgentIds)].sort(),
    ...(addressTeamId && addressAgentIds.length === 0 ? [addressTeamId] : []),
  ]);
}

/**
 * Build semantic intent for a message typed into a thread.
 *
 * Addressing is resolved and validated before this serialization boundary.
 */
export function threadMessageInput({ text, addressAgentIds, addressTeamId = null, userMessageId }: {
  text: string;
  /** Empty intentionally addresses the whole room. */
  addressAgentIds: readonly string[];
  /** Another team on the thread's computer; ignored when agents are named. */
  addressTeamId?: string | null;
  userMessageId: string;
}): ThreadMessageInput {
  return {
    text,
    intent: "accomplish",
    userMessageId,
    idempotencyKey: userMessageId,
    ...(addressAgentIds.length
      ? { addressAgentIds: [...addressAgentIds] }
      : addressTeamId
      ? { addressTeamId }
      : {}),
  };
}

/**
 * Which team, if any, runs a started thread's next round.
 *
 * A thread is pinned to its computer, not to a roster, so the composer may
 * aim a round at any team on that computer — or, in a team thread, at one
 * agent. `roomTarget` is the store's "whole room" flag: in a team thread the
 * room *is* the team. Only a team other than the thread's own needs to be
 * named on the wire; the thread's own team is simply the room.
 */
export function threadRoundTeam({ threadTeamId, pickedTeamId, roomTarget }: {
  threadTeamId: string | null | undefined;
  pickedTeamId: string | null;
  roomTarget: boolean;
}): { teamId: string | null; addressTeamId: string | null } {
  const teamId = pickedTeamId ?? (threadTeamId && roomTarget ? threadTeamId : null);
  return { teamId, addressTeamId: teamId && teamId !== threadTeamId ? teamId : null };
}
