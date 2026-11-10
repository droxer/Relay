import { createContext, useCallback, useContext, useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getMe, RelayApiError } from "../api";
import type { CurrentUser } from "../types";
import { clearTokens, writeSignedInHint } from "../lib/appStorage";
import { subscribeSessionRevalidation } from "../lib/sessionRevalidation";
import { useRelayStore } from "../lib/store";

const AUTH_SESSION_QUERY_KEY = ["auth", "me"] as const;
/** Personal-data providers preserve this client for auth consumers below them.
 * A new data cache must not interpret the current Account as a new sign-in. */
export const AuthSessionClientContext = createContext<QueryClient | null>(null);
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

function clearPersonalCredentials(): void {
  clearTokens();
  useRelayStore.setState({ tokens: {}, selectedUser: "", selectedSessionId: undefined, activeSessionId: null, composingNew: false });
}

async function probeSession(signal: AbortSignal, queryClient: QueryClient): Promise<CurrentUser | null> {
  try {
    const result = await getMe(signal);
    if (signal.aborted) return null;
    const previous = queryClient.getQueryData<CurrentUser | null>(AUTH_SESSION_QUERY_KEY);
    if (!result.authenticated || !result.user || previous?.id !== result.user.id) clearPersonalCredentials();
    queryClient.setQueryData(AUTH_CAPABILITIES_QUERY_KEY, result.capabilities ?? {});
    return result.authenticated && result.user ? result.user : null;
  } catch (error) {
    if (isAuthRejection(error)) {
      if (!signal.aborted) clearPersonalCredentials();
      return null;
    }
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
  const dataClient = useQueryClient();
  const queryClient = useContext(AuthSessionClientContext) ?? dataClient;
  const query = useQuery({
    queryKey: AUTH_SESSION_QUERY_KEY,
    queryFn: ({ signal }) => probeSession(signal, queryClient),
    retry: true,
    retryDelay: authRetryDelay,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  }, queryClient);

  useEffect(() => subscribeSessionRevalidation(() => {
    if (!queryClient.getQueryData<CurrentUser | null>(AUTH_SESSION_QUERY_KEY)) return;
    // Multiple rejected requests and mounted auth consumers share one probe.
    void queryClient.invalidateQueries(
      { queryKey: AUTH_SESSION_QUERY_KEY, exact: true },
      { cancelRefetch: false },
    );
  }), [queryClient]);

  const setUser = useCallback((user: CurrentUser | null) => {
    void queryClient.cancelQueries({ queryKey: AUTH_SESSION_QUERY_KEY });
    const previous = queryClient.getQueryData<CurrentUser | null>(AUTH_SESSION_QUERY_KEY);
    if (!user || previous?.id !== user.id) clearPersonalCredentials();
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
