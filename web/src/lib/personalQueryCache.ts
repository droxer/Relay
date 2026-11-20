import type { QueryClient, QueryKey } from "@tanstack/react-query";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Shared, account-scoped freshness policy for page queries. Query-specific
 * polling and explicit staleTime (e.g. approval checks and immutable artifacts)
 * still win. Mutations invalidate these keys regardless of their age. */
export function configurePersonalQueryCache(client: QueryClient): void {
  const policies: readonly [QueryKey, number][] = [
    [["task-record"], 10 * SECOND],
    [["task-workspace-status"], 10 * SECOND],
    [["skills"], 30 * SECOND],
    [["account", "tags"], MINUTE],
    [["workspace-files"], 10 * SECOND],
    [["workspace-file"], 10 * SECOND],
    [["workspace-activity"], 15 * SECOND],
    [["project-manager"], 2 * SECOND],
    [["project-setup"], 5 * SECOND],
    [["default-agent-offers"], 10 * SECOND],
    [["relay", "notifications"], 30 * SECOND],
    [["relay", "notification-preferences"], MINUTE],
    [["connections", "list"], 10 * SECOND],
    [["connections", "providers"], 5 * MINUTE],
    [["connections", "resources"], 30 * SECOND],
    [["admin", "dashboard"], 10 * SECOND],
    [["admin", "agents"], 30 * SECOND],
    [["admin", "managed-nodes"], 10 * SECOND],
    [["admin", "settings"], MINUTE],
    [["admin", "chat-integrations"], 30 * SECOND],
    [["admin", "waitlist"], 10 * SECOND],
  ];
  for (const [queryKey, staleTime] of policies) {
    client.setQueryDefaults(queryKey, { staleTime, gcTime: 10 * MINUTE });
  }
}
