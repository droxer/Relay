"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionCapabilities } from "../api";
import { AUTH_CAPABILITIES_QUERY_KEY, AuthSessionClientContext } from "../hooks/useAuthSession";
import { ArtifactViewerProvider } from "./ArtifactViewerProvider";

/** Mounted with the Account id as its key. An old request or mutation can
 * only update its old client, never the next Account's personal space. */
export function PersonalSpaceProvider({ children }: { children: ReactNode }) {
  const authClient = useQueryClient();
  const { data: capabilities } = useQuery<SessionCapabilities>({
    queryKey: AUTH_CAPABILITIES_QUERY_KEY,
    queryFn: () => ({}),
    enabled: false,
    staleTime: Infinity,
  });
  const [client] = useState(() => {
    const scoped = new QueryClient({ defaultOptions: authClient.getDefaultOptions() });
    const flags = authClient.getQueryData<SessionCapabilities>(AUTH_CAPABILITIES_QUERY_KEY);
    if (flags) scoped.setQueryData(AUTH_CAPABILITIES_QUERY_KEY, flags);
    return scoped;
  });
  useEffect(() => {
    if (capabilities) client.setQueryData(AUTH_CAPABILITIES_QUERY_KEY, capabilities);
  }, [capabilities, client]);
  useEffect(() => () => client.clear(), [client]);

  return <AuthSessionClientContext.Provider value={authClient}>
    <QueryClientProvider client={client}>
      <ArtifactViewerProvider>{children}</ArtifactViewerProvider>
    </QueryClientProvider>
  </AuthSessionClientContext.Provider>;
}
