import { useQuery } from "@tanstack/react-query";
import { getMe, type SessionCapabilities } from "../api";

/**
 * Server switches the signed-in employee's UI depends on, from `/auth/me`.
 * Admin settings carry the same flags but only admins can read them, and
 * employees edit automations too. Until the answer arrives — or if it never
 * does — every switch reads as on: the server still refuses what it does not
 * allow, so hiding a choice by default would only hide it from no one.
 */
export function useSessionCapabilities(): Required<SessionCapabilities> {
  const query = useQuery({
    queryKey: ["auth", "capabilities"],
    queryFn: async ({ signal }) => (await getMe(signal)).capabilities ?? {},
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return { automationTriggers: query.data?.automationTriggers !== false };
}
