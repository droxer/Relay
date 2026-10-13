import { useQuery } from "@tanstack/react-query";
import type { SessionCapabilities } from "../api";
import { AUTH_CAPABILITIES_QUERY_KEY } from "./useAuthSession";

/**
 * Server switches the signed-in employee's UI depends on. They arrive with
 * `/auth/me`: the session probe in `useAuthSession` leaves them in this cache
 * (and fetches them after a sign-in, whose response carries none), so this
 * hook only reads — it never asks a second time.
 *
 * Admin settings carry the same flags but only admins can read them, and
 * employees edit automations too. Until the answer arrives — or if it never
 * does — every switch reads as on: the server still refuses what it does not
 * allow, so hiding a choice by default would only hide it from no one.
 */
export function useSessionCapabilities(): Required<SessionCapabilities> {
  const query = useQuery<SessionCapabilities>({
    queryKey: AUTH_CAPABILITIES_QUERY_KEY,
    // `enabled: false` keeps this read-only, but react-query v5 still
    // requires a queryFn; it is never invoked.
    queryFn: () => ({}),
    enabled: false,
    staleTime: Infinity,
  });
  return { automationTriggers: query.data?.automationTriggers !== false };
}
