import type { PermissionDecision, PermissionRequest } from "relay-core";
import type { RelaySession } from "../types.js";
import { omit } from "./omit.ts";

/**
 * Runtime permission prompts on a thread: a live run asked before a tool ran
 * and waits for a person. Mirrors the reducer in
 * backend/relay/core/permission_requests.py (and relay-core's session-store):
 * a prompt opens once, and closes once — a person's answer, or `expired` when
 * its run ends first.
 */

/** Mirrors `PERMISSION_HISTORY_LIMIT` there. */
const HISTORY_LIMIT = 50;

type Outcome = Pick<PermissionDecision, "decision" | "resolvedAt" | "note" | "decidedBy">;

export function withPermissionRequested(
  session: RelaySession,
  request: Omit<PermissionRequest, "requestedAt">,
  timestamp: string,
): RelaySession {
  const known = (session.permissionRequests ?? []).some((item) => item.id === request.id)
    || (session.permissionDecisions ?? []).some((item) => item.requestId === request.id);
  if (known) return session;
  return { ...session, permissionRequests: [...(session.permissionRequests ?? []), { ...request, requestedAt: timestamp }] };
}

export function withPermissionResolved(session: RelaySession, requestId: string, outcome: Outcome): RelaySession {
  const request = session.permissionRequests?.find((item) => item.id === requestId);
  return request ? closed(session, [request], outcome) : session;
}

/** Close the open prompts of `runId` (or every one): the run that asked is gone. */
export function withPermissionsExpired(session: RelaySession, timestamp: string, runId?: string): RelaySession {
  const expiring = (session.permissionRequests ?? []).filter((item) => runId === undefined || item.runId === runId);
  return expiring.length ? closed(session, expiring, { decision: "expired", resolvedAt: timestamp }) : session;
}

/** Prompts waiting on a person, oldest first — the order the run asked them. */
export function openPermissionRequests(session: Pick<RelaySession, "permissionRequests"> | undefined): PermissionRequest[] {
  return session?.permissionRequests ?? [];
}

/**
 * Whether a denial's note reaches the agent. Claude's permission-prompt tool
 * returns it as the denial message and Pi's extension hook blocks with it as
 * the reason; Codex's decline and Kimi's ACP reject carry no text, so asking
 * for one there would promise what it cannot do.
 */
export function permissionNoteReachesAgent(request: Pick<PermissionRequest, "agent">): boolean {
  return request.agent === "claude" || request.agent === "pi";
}

/**
 * The tool input as readable text: pretty JSON when it parses, otherwise the
 * backend's capped preview as is.
 */
export function permissionInputText(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

function closed(session: RelaySession, requests: PermissionRequest[], outcome: Outcome): RelaySession {
  const ids = new Set(requests.map((item) => item.id));
  const remaining = (session.permissionRequests ?? []).filter((item) => !ids.has(item.id));
  const decisions: PermissionDecision[] = requests.map((request) => ({
    requestId: request.id,
    runId: request.runId,
    ...(request.daemonNodeId ? { daemonNodeId: request.daemonNodeId } : {}),
    toolName: request.toolName,
    ...outcome,
  }));
  return {
    ...omit(session, "permissionRequests"),
    ...(remaining.length ? { permissionRequests: remaining } : {}),
    permissionDecisions: [...(session.permissionDecisions ?? []), ...decisions].slice(-HISTORY_LIMIT),
  };
}
