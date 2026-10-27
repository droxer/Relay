import type { PermissionAnswers, PermissionDecision, PermissionRequest } from "relay-core";
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

type Outcome = Pick<PermissionDecision, "decision" | "resolvedAt" | "note" | "decidedBy" | "answers">;

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

/** A prompt that asks the person something, rather than for an approval. */
export function isQuestionPrompt(request: Pick<PermissionRequest, "questions">): boolean {
  return (request.questions?.length ?? 0) > 0;
}

/**
 * Whether the picks so far answer every question: at least one pick each,
 * one at most unless the question allows several. Free text counts as a pick.
 */
export function answersComplete(request: Pick<PermissionRequest, "questions">, answers: PermissionAnswers): boolean {
  return (request.questions ?? []).every((question) => {
    const picks = answers[question.id] ?? [];
    return picks.length > 0 && (question.multiSelect || picks.length === 1);
  });
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

/** Input keys that name what a tool acts on, most telling first. */
const SUMMARY_KEYS = ["command", "file_path", "path", "notebook_path", "url", "pattern", "query"] as const;

/**
 * Name what a prompt let a tool do — the command, the file, the URL.
 * Preserve the complete available text and its whitespace for inspection;
 * the transcript uses CSS ellipsis for its inline preview. Undefined when
 * the input says nothing (`{}` or blank).
 */
export function permissionInputSummary(input: string | undefined): string | undefined {
  if (!input?.trim()) return undefined;
  let text = input;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const fields = parsed as Record<string, unknown>;
      const named = SUMMARY_KEYS.map((key) => fields[key]).find((value): value is string => typeof value === "string" && value.trim() !== "");
      if (!named && Object.keys(fields).length === 0) return undefined;
      text = named ?? JSON.stringify(parsed);
    }
  } catch {
    // A capped preview is not JSON; show it as is.
  }
  return text.trim() ? text : undefined;
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
