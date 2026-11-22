import { relayApiEndpoint } from "../lib/apiOrigin.ts";
import type {
  AgentRunInput,
  RelaySession,
  SessionSummariesResponse,
  ThreadMessageInput,
  ThreadRecoveryInput,
} from "../types.ts";
import { apiJson, fetchWithSession, RelayApiError, RelayApiShapeError, readApiResponse, revisionPath } from "./client.ts";
import type { PermissionAnswerInput } from "../lib/permissionRequests.ts";
import type { ThreadPermissionMode, WorkflowAttemptBinding } from "relay-core";
import { sessionGuard, sessionSummariesGuard } from "./responseShape.ts";

/** One page of the thread list, newest first. Without a page this is the
 *  backend's default-sized first page. */
export type SessionHeadCache = { etag?: string; page?: SessionSummariesResponse };

export async function listSessionSummaries(
  signal?: AbortSignal,
  page?: { limit: number; cursor?: string; includeActivity?: boolean },
  headCache?: SessionHeadCache,
): Promise<SessionSummariesResponse> {
  const params = new URLSearchParams({ view: "summary" });
  if (page) params.set("limit", String(page.limit));
  if (page?.cursor) params.set("cursor", page.cursor);
  if (page?.includeActivity) params.set("include", "activity");
  const path = `/threads?${params}`;
  if (!headCache) return apiJson(path, { signal, guard: sessionSummariesGuard });
  const cached = headCache.page;
  const validator = cached ? headCache.etag : undefined;
  const response = await fetchWithSession(relayApiEndpoint(revisionPath(path, validator)), {
    signal,
    credentials: "include",
    cache: validator ? "no-store" : "default",
  });
  if (response.status === 304 && cached) return cached;
  const result = await readApiResponse(response, `GET ${path}`, sessionSummariesGuard);
  if (!signal?.aborted) {
    headCache.page = result;
    headCache.etag = response.headers.get("etag") ?? undefined;
  }
  return result;
}

/** One thread's last server-validated snapshot, owned by its Account's QueryClient. */
export type SessionSnapshotCache = { snapshot?: RelaySession; etag?: string; eventsRevision?: string };

export type ThreadWorkflow = Pick<RelaySession, "id" | "status" | "workflowRuns" | "activeWorkflowRunId">
  & { ownerUserId?: string | null };

export function getThreadWorkflow(sessionId: string, signal?: AbortSignal): Promise<ThreadWorkflow> {
  return apiJson(`/threads/${encodeURIComponent(sessionId)}?view=workflow`, { signal });
}

export function getTaskWorkflowHistory(taskId: string, signal?: AbortSignal): Promise<{ threads: ThreadWorkflow[] }> {
  return apiJson(`/tasks/${encodeURIComponent(taskId)}/workflow-history`, { signal });
}

export async function getSession(sessionId: string, signal?: AbortSignal, cache?: SessionSnapshotCache): Promise<RelaySession> {
  const path = `/threads/${encodeURIComponent(sessionId)}`;
  if (!cache) return apiJson(path, { signal, guard: sessionGuard });

  const previous = cache.snapshot?.id === sessionId ? cache.snapshot : undefined;
  const endpoint = `${path}?view=transcript&window=compact`;
  const knownEvents = previous && cache.eventsRevision
    ? `${previous.eventStart ?? 0}:${previous.events.length}:${cache.eventsRevision}`
    : undefined;
  const response = await fetchWithSession(relayApiEndpoint(revisionPath(endpoint, previous ? cache.etag : undefined, knownEvents)), {
    signal,
    credentials: "include",
    cache: "no-store",
  });
  if (response.status === 304 && previous) return previous;

  const { eventOffset, eventsRevision, ...snapshot } = await readApiResponse(
    response, `GET ${endpoint}`, sessionGuard,
  ) as RelaySession & { eventOffset?: number; eventsRevision?: string; eventCount?: number };
  if (eventsRevision !== undefined || eventOffset !== undefined) {
    const start = snapshot.eventStart;
    const previousEnd = previous ? (previous.eventStart ?? 0) + previous.events.length : undefined;
    if (typeof eventsRevision !== "string" || !/^[0-9a-f]{64}$/.test(eventsRevision)
      || typeof start !== "number" || !Number.isSafeInteger(start) || start < 0
      || typeof eventOffset !== "number"
      || (eventOffset !== start && (start !== (previous?.eventStart ?? 0) || eventOffset !== previousEnd))
      || eventOffset + snapshot.events.length !== snapshot.eventCount) {
      throw new RelayApiShapeError(`GET ${endpoint}`, "events", "the event suffix does not match the cached prefix", response.status);
    }
    if (eventOffset > start && previous) {
      snapshot.events = snapshot.events.length ? [...previous.events, ...snapshot.events] : previous.events;
    }
    snapshot.transcriptRevision = eventsRevision;
    const logs = new Map<string, string>();
    for (const event of snapshot.events) {
      if (event.type === "agent.completed" && event.agentLog !== undefined) logs.set(event.runId, event.agentLog);
    }
    snapshot.agentRuns = snapshot.agentRuns.map(run => {
      const agentLog = logs.get(run.id);
      return run.agentLog === undefined && agentLog !== undefined ? { ...run, agentLog } : run;
    });
  }
  if (!signal?.aborted) {
    cache.snapshot = snapshot;
    cache.etag = response.headers.get("etag") ?? undefined;
    cache.eventsRevision = eventsRevision;
  }
  return snapshot;
}

export type TranscriptPage = { eventStart: number; eventCount: number; events: RelaySession["events"] };

export async function readOlderTranscript(sessionId: string, before: number, signal?: AbortSignal): Promise<TranscriptPage> {
  const path = `/threads/${encodeURIComponent(sessionId)}?view=transcript&before=${before}`;
  const page = await apiJson<TranscriptPage>(path, { signal });
  if (!page || !Number.isSafeInteger(page.eventStart) || page.eventStart < 0 || page.eventStart >= before
    || page.eventCount !== before || !Array.isArray(page.events) || page.eventStart + page.events.length !== before) {
    throw new RelayApiShapeError(`GET ${path}`, "events", "the older page is not contiguous", 200);
  }
  return page;
}

export async function readArtifactText(
  sessionId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchWithSession(
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
  const response = await fetchWithSession(
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
      ...(input.connectionGrants !== undefined ? { connectionGrants: input.connectionGrants } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
      ...(input.daemonNodeId ? { daemonNodeId: input.daemonNodeId } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      // The canonical Workflow selection; `style` is its legacy alias and
      // goes only when no Workflow is named, so the two never contradict.
      ...(input.teamId && input.workflowId && !input.assignments?.length ? { workflowId: input.workflowId } : {}),
      ...(input.teamId && input.style && !input.workflowId && !input.assignments?.length ? { style: input.style } : {}),
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
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/messages?view=compact`, {
    method: "POST",
    body: {
      text: input.text,
      ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
      intent: input.intent,
      ...(input.workflowId && input.intent === "accomplish" && !input.addressAgentIds?.length ? { workflowId: input.workflowId } : {}),
      ...(input.style && !input.workflowId && input.intent === "accomplish" && !input.addressAgentIds?.length ? { style: input.style } : {}),
      ...(input.addressAgentIds?.length
        ? { addressAgentIds: input.addressAgentIds }
        : input.addressTeamId
        ? { addressTeamId: input.addressTeamId }
        : {}),
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.questionId && input.intent === "accomplish"
        ? { questionId: input.questionId, ...(input.approve ? { approve: true } : {}) }
        : {}),
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

export function cancelRun(sessionId: string, token?: string, reason?: string, preserveQueue = false): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/cancellations`, {
    method: "POST",
    token,
    body: { reason: reason ?? "Cancelled from Relay Web UI.", ...(preserveQueue ? { preserveQueue: true } : {}) },
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

/** An owner decision on a workflow run's current attempt. 409 when the
 *  binding is stale — the caller refetches the thread and asks again. */
export function decideWorkflow(
  sessionId: string,
  kind: "approve" | "reject" | "retry" | "cancel" | "answer",
  binding: WorkflowAttemptBinding,
  answer?: string,
): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/workflow-decisions`, {
    method: "POST",
    body: { kind, ...binding, ...(kind === "answer" ? { answer } : {}) },
  });
}

/** Answer a live run's runtime permission prompt; 409 once it has closed. */
export function answerPermissionRequest(
  sessionId: string,
  requestId: string,
  { decision, note, answers, always }: PermissionAnswerInput,
): Promise<RelaySession> {
  return apiJson<RelaySession>(
    `/threads/${encodeURIComponent(sessionId)}/permission-requests/${encodeURIComponent(requestId)}`,
    {
      method: "POST",
      body: { decision, ...(note ? { note } : {}), ...(answers ? { answers } : {}), ...(always ? { always: true } : {}) },
    },
  );
}

export function setThreadPermissionMode(sessionId: string, mode: ThreadPermissionMode): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/permission-mode`, {
    method: "PUT",
    body: { mode },
    guard: sessionGuard,
  });
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

export async function uploadThreadImage(file: File, signal?: AbortSignal): Promise<import("relay-core").ThreadImageAttachment> {
  // WebKit can send an empty body for picker-backed Files (bug 319985).
  // Send buffered bytes directly, bypassing File/Blob resolution in the
  // network process (including for pages controlled by a service worker).
  signal?.throwIfAborted();
  const body = await file.arrayBuffer();
  signal?.throwIfAborted();
  const response = await fetchWithSession(relayApiEndpoint("/thread-attachments"), {
    method: "POST", credentials: "include", signal,
    headers: { "Content-Type": file.type }, body,
  });
  return readApiResponse(response, "POST /thread-attachments");
}
