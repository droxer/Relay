import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getMe, RelayApiError } from "../api";
import type { CurrentUser } from "../types";
import { writeSignedInHint } from "../lib/appStorage";

const AUTH_SESSION_QUERY_KEY = ["auth", "me"] as const;
/** Where the `/auth/me` probe leaves the server's capability switches, so
    `useSessionCapabilities` reads them without asking a second time. */
export const AUTH_CAPABILITIES_QUERY_KEY = ["auth", "capabilities"] as const;

const MAX_RETRY_DELAY_MS = 15_000;

/** `checking` and `unreachable` both mean "not known yet": the shell stays
    gated, and only `anonymous` — a definitive 401/403 — sends the visitor to
    sign in. Treating a dropped connection as signed out bounced every open tab
    to /login whenever the backend restarted. */
type AuthStatus = "checking" | "unreachable" | "authenticated" | "anonymous";

function isAuthRejection(error: unknown): boolean {
  return error instanceof RelayApiError && (error.status === 401 || error.status === 403);
}

function authRetryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

async function probeSession(signal: AbortSignal, queryClient: QueryClient): Promise<CurrentUser | null> {
  try {
    const result = await getMe(signal);
    queryClient.setQueryData(AUTH_CAPABILITIES_QUERY_KEY, result.capabilities ?? {});
    return result.authenticated && result.user ? result.user : null;
  } catch (error) {
    if (isAuthRejection(error)) return null;
    throw error;
  }
}

// Owns the authenticated-user session: probes /auth/me, retrying with backoff
// until the backend answers, then exposes the current user plus a setter for
// login/logout transitions. authChecked gates the app shell until a definitive
// answer arrives.
export function useAuthSession(): {
  user: CurrentUser | null;
  authChecked: boolean;
  status: AuthStatus;
  setUser: (user: CurrentUser | null) => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: AUTH_SESSION_QUERY_KEY,
    queryFn: ({ signal }) => probeSession(signal, queryClient),
    retry: true,
    retryDelay: authRetryDelay,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const setUser = useCallback((user: CurrentUser | null) => {
    void queryClient.cancelQueries({ queryKey: AUTH_SESSION_QUERY_KEY });
    queryClient.setQueryData<CurrentUser | null>(AUTH_SESSION_QUERY_KEY, user);
    // A sign-in answers with the user alone; the capability switches only
    // come from /auth/me, so fetch them once for the new session.
    if (user) {
      void queryClient.fetchQuery({
        queryKey: AUTH_CAPABILITIES_QUERY_KEY,
        queryFn: async ({ signal }) => (await getMe(signal)).capabilities ?? {},
      }).catch(() => undefined);
    } else {
      queryClient.removeQueries({ queryKey: AUTH_CAPABILITIES_QUERY_KEY });
    }
  }, [queryClient]);

  const user = query.data ?? null;
  const known = query.isSuccess;
  const signedIn = Boolean(query.data);
  // Only a definitive answer moves the first-paint hint; an unreachable
  // backend leaves it where it was.
  useEffect(() => {
    if (known) writeSignedInHint(signedIn);
  }, [known, signedIn]);

  const status: AuthStatus = query.isSuccess
    ? (user ? "authenticated" : "anonymous")
    : query.failureCount > 0 ? "unreachable" : "checking";

  return { user, authChecked: query.isSuccess, status, setUser };
}
