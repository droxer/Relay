import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listControlPanelEmployees } from "../api";
import type { CurrentUser } from "../types";
import { ADMIN_EMPLOYEES_KEY } from "../lib/controlPanelQueries";

/**
 * Employee id → display name, for surfaces that show work owned by someone
 * other than the viewer (the backlog and routine Assignee columns).
 *
 * The roster only exists behind `/api/v1/admin/employees`, which requires an admin
 * session, so this resolves names for admins and returns an empty map for
 * everyone else — those viewers keep the previous id fallback. Closing that
 * gap needs a non-admin directory endpoint, which is a roster-exposure
 * decision rather than a display one.
 *
 * Shares ADMIN_EMPLOYEES_KEY with useAdminNodes, so an admin who has opened
 * the admin console pays no extra request.
 */
export function useEmployeeNames(currentUser: CurrentUser): ReadonlyMap<string, string> {
  const enabled = currentUser.role === "admin";
  const { data } = useQuery({
    queryKey: ADMIN_EMPLOYEES_KEY,
    queryFn: async ({ signal }: { signal: AbortSignal }) =>
      (await listControlPanelEmployees(signal)).employees,
    enabled,
    staleTime: 60_000,
  });

  return useMemo(() => {
    const names = new Map<string, string>();
    for (const employee of data ?? []) {
      /* An employee who never set a display name used to fall through to the
         raw UUID everywhere this map feeds — the @handle is the name they
         actually answer to. */
      const name = employee.displayName?.trim() || employee.handle;
      if (employee.id && name) names.set(employee.id, name);
    }
    return names;
  }, [data]);
}
