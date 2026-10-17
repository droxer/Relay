import { relayApiEndpoint } from "../lib/apiOrigin.ts";
import type {
  AgentRunInput,
  RelaySession,
  SessionSummariesResponse,
  ThreadMessageInput,
  ThreadRecoveryInput,
} from "../types.ts";
import { apiJson, RelayApiError } from "./client.ts";
import { sessionGuard, sessionSummariesGuard } from "./responseShape.ts";

export function listSessionSummaries(signal?: AbortSignal): Promise<SessionSummariesResponse> {
  return apiJson<SessionSummariesResponse>("/threads?view=summary", { signal, guard: sessionSummariesGuard });
}

export function getSession(sessionId: string, signal?: AbortSignal): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}`, { signal, guard: sessionGuard });
}

export async function readArtifactText(
  sessionId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    relayApiEndpoint(`/threads/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`),
    { credentials: "include", signal },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new RelayApiError(text.trim() || response.statusText, response.status);
  }
  return text;
}

/** An artifact's bytes, for previews the raw URL cannot back directly. The
 *  raw route answers `attachment` with `frame-ancestors 'none'` (it is a
 *  download, and must never render on this origin), so a PDF preview frames
 *  these bytes as a `data:` URL instead. */
export async function readArtifactBlob(
  sessionId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(
    relayApiEndpoint(`/threads/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`),
    { credentials: "include", signal },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new RelayApiError(text.trim() || response.statusText, response.status);
  }
  return response.blob();
}

export function runLogicalAgents(input: AgentRunInput): Promise<RelaySession> {
  return apiJson<RelaySession>("/agent-runs", {
    method: "POST",
    body: {
      taskGoal: input.taskGoal,
      ...(input.daemonNodeId ? { daemonNodeId: input.daemonNodeId } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.teamId && input.style && !input.assignments?.length ? { style: input.style } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.assignments ? { assignments: input.assignments } : {}),
      sessionId: input.sessionId,
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
    },
  });
}

export function submitThreadMessage(
  sessionId: string,
  input: ThreadMessageInput,
): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: {
      text: input.text,
      intent: input.intent,
      ...(input.style && input.intent === "accomplish" && !input.addressAgentIds?.length ? { style: input.style } : {}),
      ...(input.addressAgentIds?.length
        ? { addressAgentIds: input.addressAgentIds }
        : input.addressTeamId
        ? { addressTeamId: input.addressTeamId }
        : {}),
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.questionId && input.intent === "accomplish" ? { questionId: input.questionId } : {}),
    },
  });
}

export function requestThreadRecovery(
  sessionId: string,
  input: ThreadRecoveryInput,
): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/recoveries`, {
    method: "POST",
    body: {
      kind: input.kind,
      targetAgentId: input.targetAgentId,
      ...(input.note ? { note: input.note } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.resume ? { resume: true } : {}),
    },
  });
}

export function cancelRun(sessionId: string, token?: string, reason?: string): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/cancellations`, {
    method: "POST",
    token,
    body: { reason: reason ?? "Cancelled from Relay Web UI." },
  });
}

export function recordDecision(
  sessionId: string,
  // Rerun and handoff dispatch an agent, so they go through /agent-runs; this
  // route records decisions that need no new turn.
  kind: "approve" | "reject" | "mark_done",
  note?: string,
  token?: string,
): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/decisions`, {
    method: "POST",
    token,
    body: { kind, note },
  });
}

/** Answer a live run's runtime permission prompt; 409 once it has closed. */
export function answerPermissionRequest(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
  note?: string,
  token?: string,
): Promise<RelaySession> {
  return apiJson<RelaySession>(
    `/threads/${encodeURIComponent(sessionId)}/permission-requests/${encodeURIComponent(requestId)}`,
    { method: "POST", token, body: { decision, ...(note ? { note } : {}) } },
  );
}

export function archiveSession(sessionId: string, token?: string): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    token,
    body: { archived: true },
  });
}

export function retryExecutionRecovery(sessionId: string, token?: string): Promise<NonNullable<RelaySession["execution"]>> {
  return apiJson<NonNullable<RelaySession["execution"]>>(`/threads/${encodeURIComponent(sessionId)}/execution/recovery`, { method: "POST", token });
}

/** Assert the agent is gone so Relay releases an execution whose computer will
 *  never report exit. Refused (409) unless recovery is already required. */
export function reconcileExecution(sessionId: string, token?: string): Promise<NonNullable<RelaySession["execution"]>> {
  return apiJson<NonNullable<RelaySession["execution"]>>(`/threads/${encodeURIComponent(sessionId)}/execution/reconcile`, { method: "POST", token });
}

export function deleteSession(sessionId: string, token?: string): Promise<RelaySession["execution"] | undefined> {
  return apiJson<RelaySession["execution"] | undefined>(`/threads/${encodeURIComponent(sessionId)}?stop=true`, {
    method: "DELETE",
    token,
  });
}

export function renameSession(sessionId: string, title: string, token?: string): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    token,
    body: { title },
  });
}
