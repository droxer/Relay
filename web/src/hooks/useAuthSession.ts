import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe, RelayApiError } from "../api";
import type { CurrentUser } from "../types";

const AUTH_SESSION_QUERY_KEY = ["auth", "me"] as const;

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

async function probeSession(signal: AbortSignal): Promise<CurrentUser | null> {
  try {
    const result = await getMe(signal);
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
    queryFn: ({ signal }) => probeSession(signal),
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
  }, [queryClient]);

  const user = query.data ?? null;
  const status: AuthStatus = query.isSuccess
    ? (user ? "authenticated" : "anonymous")
    : query.failureCount > 0 ? "unreachable" : "checking";

  return { user, authChecked: query.isSuccess, status, setUser };
}
