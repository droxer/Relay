import type {
  CreateTaskInput,
  RelayTask,
  RoutineSchedule,
  StartTaskResponse,
  TaskArtifactsResponse,
  TaskDeletionResponse,
  TaskEventsResponse,
  TaskFilesResponse,
  TaskMutationInput,
  TaskRunAssignment,
  TaskRunsResponse,
  TasksResponse,
} from "../types.ts";
import { apiJson } from "./client.ts";
import { taskGuard, tasksGuard } from "./responseShape.ts";

export function listTasks(signal?: AbortSignal): Promise<TasksResponse> {
  return apiJson<TasksResponse>("/tasks?view=summary", { signal, guard: tasksGuard });
}

export function createTask(input: CreateTaskInput): Promise<RelayTask> {
  const { collaborationStyle, ...fields } = input;
  return apiJson<RelayTask>("/tasks", {
    method: "POST",
    body: { ...fields, ...(collaborationStyle ? { collaborationStyle } : {}) },
  });
}

/** One task or routine, by id. The list poll carries most records already,
 *  but a deep link to a record arrives before the list resolves — and an
 *  occurrence may sit outside whatever the list is showing. */
export function getTask(taskId: string, signal?: AbortSignal): Promise<RelayTask> {
  return apiJson<RelayTask>(`/tasks/${encodeURIComponent(taskId)}`, { signal, guard: taskGuard });
}

export function updateTask(taskId: string, input: TaskMutationInput): Promise<RelayTask> {
  return apiJson<RelayTask>(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: input,
  });
}

/** Replace a task's prerequisites: tasks in its project that must be done first. */
export function setTaskPrerequisites(taskId: string, prerequisiteTaskIds: string[]): Promise<RelayTask> {
  return apiJson<RelayTask>(`/tasks/${encodeURIComponent(taskId)}/prerequisites`, {
    method: "PUT",
    body: { prerequisiteTaskIds },
  });
}

export function deleteTask(taskId: string): Promise<TaskDeletionResponse> {
  return apiJson<TaskDeletionResponse>(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
}

export function assignTask(taskId: string, agentId: string): Promise<RelayTask> {
  return apiJson<RelayTask>(`/tasks/${encodeURIComponent(taskId)}/assignment`, {
    method: "PUT",
    body: { agentId },
  });
}

export function startTask(
  taskId: string,
  input: { assignments?: TaskRunAssignment[] } = {},
): Promise<StartTaskResponse> {
  return apiJson<StartTaskResponse>(`/tasks/${encodeURIComponent(taskId)}/runs`, {
    method: "POST",
    body: input,
  });
}

export function taskWorkspaceStatus(taskId: string, signal?: AbortSignal): Promise<{
  waiting: boolean; blockingSessionId?: string; blockingTitle?: string;
}> {
  return apiJson(`/tasks/${encodeURIComponent(taskId)}/workspace/status`, { signal });
}

export function listTaskArtifacts(taskId: string, signal?: AbortSignal, allVersions = false): Promise<TaskArtifactsResponse> {
  return apiJson<TaskArtifactsResponse>(`/tasks/${encodeURIComponent(taskId)}/artifacts${allVersions ? "?versions=all" : ""}`, { signal });
}

/** A task's produced files, enriched with current live workspace state. */
export function listTaskFiles(
  input: { taskId: string; path?: string; allVersions?: boolean },
  signal?: AbortSignal,
): Promise<TaskFilesResponse> {
  const params = new URLSearchParams();
  if (input.path) params.set("path", input.path);
  if (input.allVersions) params.set("versions", "all");
  const query = params.toString();
  return apiJson<TaskFilesResponse>(
    `/tasks/${encodeURIComponent(input.taskId)}/files${query ? `?${query}` : ""}`,
    { signal },
  );
}

/**
 * The task's event log — the run history behind its current state.
 *
 * `includeOccurrences` folds in the logs of a routine's promoted occurrences,
 * which is where a routine's runs actually happen.
 */
export function listTaskEvents(
  taskId: string,
  options: { includeOccurrences?: boolean } = {},
  signal?: AbortSignal,
): Promise<TaskEventsResponse> {
  const query = options.includeOccurrences ? "?include=occurrences" : "";
  return apiJson<TaskEventsResponse>(`/tasks/${encodeURIComponent(taskId)}/events${query}`, { signal });
}

/**
 * The task's run ledger — one row per run, newest first.
 *
 * A routine's rows are its promoted occurrences; a plain task answers with a
 * single row for its own run.
 */
export function listTaskRuns(
  taskId: string,
  options: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<TaskRunsResponse> {
  const query = options.limit ? `?limit=${encodeURIComponent(String(options.limit))}` : "";
  return apiJson<TaskRunsResponse>(`/tasks/${encodeURIComponent(taskId)}/runs${query}`, { signal });
}

export type WebhookSecretStatus = { configured: boolean; path: string; header: string };

export function webhookSecretStatus(taskId: string, signal?: AbortSignal): Promise<WebhookSecretStatus> {
  return apiJson(`/tasks/${encodeURIComponent(taskId)}/automation/webhook-secret`, { signal });
}

export function rotateWebhookSecret(taskId: string): Promise<WebhookSecretStatus & { secret: string }> {
  return apiJson(`/tasks/${encodeURIComponent(taskId)}/automation/webhook-secret`, { method: "POST" });
}

/** Turn a paused automation back on (owner or admin). Clears Relay's pause,
 *  its pending events, rate window, and failure streak; a no-op when active. */
export function resumeAutomation(taskId: string): Promise<RelayTask> {
  return apiJson<RelayTask>(`/tasks/${encodeURIComponent(taskId)}/automation/resume`, { method: "POST" });
}

/** A schedule's summary and next three fires (ISO UTC), before it is saved. */
export type SchedulePreview = { summary: string; next: string[] };

export function previewSchedule(schedule: RoutineSchedule, signal?: AbortSignal): Promise<SchedulePreview> {
  return apiJson("/automations/schedule-preview", { method: "POST", body: { schedule }, signal });
}
