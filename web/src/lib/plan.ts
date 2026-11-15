import type { AgentName } from "../types.js";
import { runtimeLabel } from "./runtimeLabel.ts";

export type PlanStep = { agent: AgentName };

/**
 * Parse the JSON body of a "plan" artifact (`{ assignments: WorkflowStep[] }`)
 * into a list of human-readable steps. `agentNames` is the set of recognized
 * agents used to drop unknown entries (passed in so this module stays free of
 * runtime imports). Returns null when the body is not a recognizable assignment
 * plan so callers can fall back to the raw preview.
 */
export function parsePlanSteps(text: string, agentNames: readonly string[]): PlanStep[] | null {
  try {
    const data = JSON.parse(text) as { assignments?: unknown };
    if (!Array.isArray(data.assignments)) return null;
    const steps = data.assignments.flatMap((entry): PlanStep[] => {
      if (!entry || typeof entry !== "object") return [];
      const { agent } = entry as { agent?: unknown };
      if (typeof agent !== "string" || !agentNames.includes(agent)) return [];
      return [{ agent: agent as AgentName }];
    });
    return steps.length > 0 ? steps : null;
  } catch {
    return null;
  }
}

export function agentLabel(agent: AgentName): string {
  return runtimeLabel(agent);
}
