import { useQuery } from "@tanstack/react-query";

import { readArtifactText } from "../api";

/**
 * Caches the immutable body by (session, artifact). The viewer fetches it on
 * open, and a chip can observe that result with its own fetch disabled.
 */
export function useArtifactBody(
  sessionId: string,
  artifactId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["artifact", sessionId, artifactId],
    queryFn: ({ signal }) => readArtifactText(sessionId, artifactId, signal),
    enabled: options.enabled ?? true,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    retry: false,
  });
}
