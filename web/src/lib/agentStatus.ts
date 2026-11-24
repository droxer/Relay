import type { LogicalAgentAvailability, Tone, UserAgent } from "../types";
import type { StateShape, StateTone } from "../components/StateMark";
import { statusTone } from "./statusTone";

export interface AgentRosterStatus {
  /** Translation key for the single most specific visible status label. */
  key: string;
  /** Semantic tone for the label text and status mark. */
  tone: StateTone;
  /** Shape half of Relay's state vocabulary (ring = unavailable/problem, live = active). */
  shape: StateShape;
  /** Whether the agent cannot currently accept work (used for subtle row hierarchy). */
  unavailable: boolean;
  /** Fallback string when a future backend status has no translation entry yet. */
  defaultValue?: string;
}

/**
 * Resolve the single most specific status readout for a logical agent.
 *
 * Shared by the personal Agents roster row and AgentDetailPage so the list and
 * detail views never disagree when an agent is unavailable (e.g. showing
 * "Runtime not available" in the list and bare "Offline" in detail).
 */
export function describeAgentRosterStatus(
  agent: Pick<UserAgent, "enabled" | "availability" | "bindingStatus">,
): AgentRosterStatus | null {
  if (!agent.enabled) {
    return {
      key: "agents_page.disabled",
      tone: "neutral",
      shape: "ring",
      unavailable: true,
    };
  }

  const { availability, bindingStatus } = agent;
  if (availability === "offline" && bindingStatus && bindingStatus !== "available") {
    const tone: Tone = bindingStatus === "computer_offline" ? "neutral" : "bad";
    return {
      key: `agents_page.binding_status_${bindingStatus}`,
      tone,
      shape: "ring",
      unavailable: true,
    };
  }

  if (availability === "ready") return null;

  if (availability === "offline") {
    return {
      key: "status.offline",
      tone: "neutral",
      shape: "ring",
      unavailable: true,
    };
  }

  if (availability === "busy") {
    return {
      key: "status.busy",
      tone: "live",
      shape: "live",
      unavailable: false,
    };
  }

  const fallbackAvailability: LogicalAgentAvailability = availability;
  return {
    key: `status.${fallbackAvailability}`,
    tone: statusTone(fallbackAvailability),
    shape: "solid",
    unavailable: false,
    defaultValue: fallbackAvailability,
  };
}
