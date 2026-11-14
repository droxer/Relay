import type { AgentName } from "../types.js";

/** Runtimes offered by the UI. */
export const AGENT_RUNTIME_DISPLAY_ORDER: readonly AgentName[] = ["codex", "claude", "pi", "opencode"];

export function isVisibleAgentRuntime(agent: string): agent is AgentName {
  return AGENT_RUNTIME_DISPLAY_ORDER.some((name) => name === agent);
}
