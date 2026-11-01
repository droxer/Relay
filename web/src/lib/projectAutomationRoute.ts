import { canonicalBrowserUrl } from "./appRoute.ts";

/** Project automation records and runs share the project's Automations tab. */
export function projectAutomationHref(projectId: string, automationId: string, runId?: string | null): string {
  const search = new URLSearchParams({ tab: "automations", automation: automationId });
  if (runId) search.set("run", runId);
  return canonicalBrowserUrl(`/projects/${encodeURIComponent(projectId)}`, search.toString());
}
