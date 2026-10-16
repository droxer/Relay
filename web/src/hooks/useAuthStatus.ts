import { useQuery } from "@tanstack/react-query";
import { getAuthStatus } from "../api";

const AUTH_STATUS_QUERY_KEY = ["auth", "status"] as const;

/** Whether the server takes requests for access: `null` until it answers
    (or when it cannot be reached), so a caller can tell "off" from "unknown".
    The flag lives on the backend alone; the signed-out screens learn it at
    runtime rather than from a build-time switch. */
export function useWaitlistEnabled(): boolean | null {
  return useAuthStatus()?.waitlistEnabled ?? null;
}

/** Whether "Forgot password?" can deliver a link — the server must be able
    to send email. `null` until it answers, like `useWaitlistEnabled`. */
export function usePasswordResetEnabled(): boolean | null {
  return useAuthStatus()?.passwordResetEnabled ?? null;
}

function useAuthStatus() {
  const query = useQuery({
    queryKey: AUTH_STATUS_QUERY_KEY,
    queryFn: ({ signal }) => getAuthStatus(signal),
    staleTime: Infinity,
    retry: false,
  });
  return query.data;
}
