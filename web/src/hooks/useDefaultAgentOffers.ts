"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { acceptDefaultAgents, declineDefaultAgents, listDefaultAgentOffers, type DefaultAgentOffer } from "../api";
import { splitDefaultAgentAnswer } from "../lib/defaultAgentOffers";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import type { AgentName } from "../types";
import { USER_AGENTS_QUERY_KEY } from "./useUserAgents";

export const DEFAULT_AGENT_OFFERS_QUERY_KEY = "default-agent-offers";

type Answer = { offer: DefaultAgentOffer; selected: ReadonlySet<AgentName> };

/**
 * The default agents connected computers offer, and the one answer a person
 * gives each: create the checked runtimes' agents and decline the rest. Polls
 * at the computers' own cadence, since an offer appears when one connects.
 */
export function useDefaultAgentOffers(userId?: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [DEFAULT_AGENT_OFFERS_QUERY_KEY, userId],
    queryFn: ({ signal }) => listDefaultAgentOffers(signal),
    enabled: Boolean(userId),
    refetchInterval: RELAY_POLL_INTERVALS_MS.nodes,
  });
  const answer = useMutation({
    mutationFn: async ({ offer, selected }: Answer) => {
      const { accept, decline } = splitDefaultAgentAnswer(offer, selected);
      // Decline first: if creating then fails, the person is asked again
      // only about what they wanted, not about what they already refused.
      if (decline.length > 0) await declineDefaultAgents({ computerId: offer.computerId, executorKinds: decline });
      const created = accept.length > 0
        ? (await acceptDefaultAgents({ computerId: offer.computerId, executorKinds: accept })).agents
        : [];
      return created;
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [DEFAULT_AGENT_OFFERS_QUERY_KEY] }),
        queryClient.invalidateQueries({ queryKey: [USER_AGENTS_QUERY_KEY] }),
      ]);
    },
  });
  return {
    offers: query.data?.offers ?? [],
    answer: answer.mutateAsync,
    get isAnswering() { return answer.isPending; },
  };
}
