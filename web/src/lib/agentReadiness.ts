import type { TFunction } from "i18next";
import type { AgentName, DaemonNodeMonitorRecord } from "../types.js";

type AgentReadiness = "ready" | "disabled" | "failed" | "unknown";

type NodeAgentState = Pick<DaemonNodeMonitorRecord, "agents" | "disabledAgents"> | undefined;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

export function agentReadiness(node: NodeAgentState, agent: AgentName): AgentReadiness {
  if ((node?.disabledAgents ?? []).includes(agent)) return "disabled";
  const status = node?.agents?.[agent] ?? "unknown";
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  return "unknown";
}

export function isAgentDispatchReady(node: NodeAgentState, agent: AgentName): boolean {
  return agentReadiness(node, agent) === "ready";
}

export function dispatchReadyAgents(node: NodeAgentState, agentNames: AgentName[]): AgentName[] {
  return agentNames.filter((agent) => isAgentDispatchReady(node, agent));
}

const NOT_READY_AGENTS_RE = /does not have ready agent\(s\): ([^.]+)/i;
const NO_PLACEMENT_RE = /^Agent (.+?) has no eligible runtime placement \(([a-z_]+)\)\.?$/i;

// Every placement rejection reaches the client as the same sentence with a
// different code (see _best_rejection_code in the backend's agent_routing).
// Each one sends the reader somewhere different — a busy node is healthy and
// needs waiting out, an offline one needs the daemon restarted — so they must
// not collapse into one generic "check the connection".
const PLACEMENT_REJECTION_KEYS: Record<string, string> = {
  workspace_unavailable: "errors.workspace_unavailable",
  capacity_exhausted: "errors.capacity_exhausted",
  node_offline: "errors.node_offline",
  executor_not_ready: "errors.executor_not_ready",
  agent_configuration_pending: "errors.agent_configuration_pending",
};

export function formatDispatchError(error: unknown, t: TFunction): string | undefined {
  const message = errorMessage(error);
  const match = message.match(NOT_READY_AGENTS_RE);
  if (match) {
    const agent = match[1].trim();
    return t("errors.agent_not_ready", { agent });
  }
  if (/disabled agent\(s\)/i.test(message)) {
    return t("errors.agent_disabled_on_node");
  }
  const noPlacement = message.match(NO_PLACEMENT_RE);
  if (noPlacement) {
    // An unrecognized code falls through to the caller's generic message
    // rather than naming a cause we cannot describe.
    const key = PLACEMENT_REJECTION_KEYS[noPlacement[2].toLowerCase()];
    if (key) return t(key, { agent: noPlacement[1].trim() });
  }
  return undefined;
}
