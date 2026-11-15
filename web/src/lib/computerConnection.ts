import type { ControlPanelDaemonNodeRecord, Tone } from "../types.js";

/**
 * What a computer's own client last reported about its link to Relay
 * (`GET /daemon-nodes/{id}/transport`). Every field is optional: an older
 * client reports nothing, and the backend answers a bare `connecting`.
 */
export interface ComputerTransportSnapshot {
  state?: string;
  causes?: string[];
  recovered?: boolean;
  pending?: number;
  quarantined?: number;
}

/** Why a connected computer still needs a look, most actionable first. */
export const CONNECTION_ISSUES = ["storage", "quarantine", "execution", "communication", "not_listening"] as const;
export type ComputerConnectionIssue = (typeof CONNECTION_ISSUES)[number];

export type ComputerConnectionState =
  /** Connected and taking work. */
  | "online"
  /** Connected, but a report channel or the command poll is retrying. */
  | "unsettled"
  /** Connected, and something on the computer needs its owner. */
  | "attention"
  /** Was connected; nothing heard within the liveness window. */
  | "offline"
  /** Its client said it was shutting down. */
  | "stopped"
  /** Its credential was refused, so its client stopped itself. */
  | "revoked"
  /** Never connected yet. */
  | "pending";

export interface ComputerConnection {
  state: ComputerConnectionState;
  tone: Tone;
  issue?: ComputerConnectionIssue;
  /** Reports the computer still holds for Relay. */
  pendingReports: number;
  /** Reports Relay refused, kept on the computer for its owner. */
  quarantinedReports: number;
}

type ConnectionNode = Pick<ControlPanelDaemonNodeRecord, "online" | "stale" | "status" | "lastSeenAt" | "dispatchable">;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * One reading of a computer's link to Relay, from facts the backend already
 * derives: liveness (`online`/`stale`, never re-derived from `lastSeenAt`),
 * whether it is listening for work (`dispatchable`), and what its client
 * last said about its own transport.
 *
 * Liveness always wins. A snapshot is the client's word, and a client that
 * went dark cannot take it back: its last "healthy" says nothing once the
 * computer is offline, and its "revoked" is stale once it is back online.
 */
export function computerConnection(
  node: ConnectionNode,
  transport?: ComputerTransportSnapshot | null,
): ComputerConnection {
  const causes = Array.isArray(transport?.causes) ? transport.causes : [];
  const reports = { pendingReports: count(transport?.pending), quarantinedReports: count(transport?.quarantined) };
  const online = Boolean(node.online) && node.stale !== true;
  if (!online) {
    if (!node.lastSeenAt) return { state: "pending", tone: "neutral", ...reports };
    if (transport?.state === "revoked" || causes.includes("revoked")) return { state: "revoked", tone: "bad", ...reports };
    return { state: node.status === "stopped" ? "stopped" : "offline", tone: "neutral", ...reports };
  }
  if (transport?.recovered !== true) {
    const issue = CONNECTION_ISSUES.find((candidate) => causes.includes(candidate));
    // A communication fault while connected is the client still retrying, not
    // something its owner can fix.
    if (issue && issue !== "communication") return { state: "attention", tone: "warn", issue, ...reports };
    if (issue || transport?.state === "retrying") return { state: "unsettled", tone: "warn", issue: "communication", ...reports };
  }
  if (node.dispatchable === false) return { state: "unsettled", tone: "warn", issue: "not_listening", ...reports };
  return { state: "online", tone: "good", ...reports };
}

/** Whether a reading has anything to say beyond the presence pill. */
export function connectionNeedsNotice(connection: ComputerConnection): boolean {
  return connection.state !== "online" && connection.state !== "pending";
}
