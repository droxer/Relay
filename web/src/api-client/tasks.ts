import type {
  CreateTaskInput,
  GitHubImportInput,
  GitHubImportResponse,
  GitHubIssueQuery,
  GitHubIssuesResponse,
  RelayTask,
  RelayTaskListItem,
  RoutineSchedule,
  StartTaskResponse,
  TaskArtifactsResponse,
  TaskDeletionResponse,
  TaskEventsResponse,
  TaskFilesResponse,
  TaskMutationInput,
  TaskListScope,
  TaskRunAssignment,
  TaskRunsResponse,
  TasksResponse,
  TaskReview,
} from "../types.ts";
import { apiJson, fetchWithSession, privateConditionalJson, readApiResponse, revisionPath, type PrivateResponseCache } from "./client.ts";
import type { IssueQueue } from "../lib/issueQueues.ts";
import type { TaskWorkflowStage } from "../lib/taskFlow.ts";
import type { RoutineListState } from "../lib/routine.ts";
import { isoToday } from "../lib/backlog.ts";
import { relayApiEndpoint } from "../lib/apiOrigin.ts";
import { taskGuard, tasksGuard, taskReviewGuard } from "./responseShape.ts";

/** Owned by the personal-space hook, never shared across Accounts. */
export type TaskListCache = { projectId?: string; scope?: TaskListScope; threadId?: string; computerId?: string; etag?: string; data?: TasksResponse };

export async function listTasks(signal?: AbortSignal, cache?: TaskListCache): Promise<TasksResponse> {
  const params = new URLSearchParams({ view: "summary" });
  if (cache?.projectId) params.set("projectId", cache.projectId);
  if (cache?.scope) params.set("scope", cache.scope);
  if (cache?.scope === "project-dashboard") params.set("today", isoToday());
  if (cache?.threadId) params.set("threadId", cache.threadId);
  if (cache?.computerId) params.set("computerId", cache.computerId);
  const path = `/tasks?${params}`;
  if (!cache) return apiJson<TasksResponse>(path, { signal, guard: tasksGuard });
  const response = await fetchWithSession(relayApiEndpoint(revisionPath(path, cache.data ? cache.etag : undefined)), {
    signal,
    credentials: "include",
    // Handle revalidation ourselves so a 304 retains the parsed object too.
    cache: "no-store",
  });
  if (response.status === 304 && cache.data) return cache.data;
  const data = await readApiResponse(response, `GET ${path}`, tasksGuard);
  if (!signal?.aborted) {
    cache.data = data;
    cache.etag = response.headers.get("etag") ?? undefined;
  }
  return data;
}

export type IssuePagePosition = { page: number; total: number };
export type UnplacedTaskPage = IssuePagePosition & { tasks: Pick<RelayTaskListItem, "id" | "title">[] };

export interface IssuesResponse extends TasksResponse {
  page?: IssuePagePosition;
  lanes?: Record<TaskWorkflowStage, IssuePagePosition>;
  /** The pre-queue count and the facets for the full matching collection. */
  issueCount?: number;
  counts?: Record<IssueQueue, number>;
  tags?: string[];
  groupTotals?: Record<string, number>;
  sectionCounts?: Record<TaskWorkflowStage, number>;
  unplaced?: UnplacedTaskPage;
}

export function listIssues(params: string, signal?: AbortSignal, cache?: PrivateResponseCache<IssuesResponse>): Promise<IssuesResponse> {
  return privateConditionalJson(`/tasks?view=summary&${params}`, signal, cache);
}

export interface AutomationsResponse extends TasksResponse {
  page?: IssuePagePosition;
  automationCount?: number;
  counts?: Record<RoutineListState, number>;
  states?: Record<string, RoutineListState>;
  tags?: string[];
  hasLiveRuns?: boolean;
  unplaced?: UnplacedTaskPage;
}

export function listAutomations(params: string, signal?: AbortSignal, cache?: PrivateResponseCache<AutomationsResponse>): Promise<AutomationsResponse> {
  return privateConditionalJson(`/tasks?view=summary&scope=automations&layout=list&${params}`, signal, cache);
}

export type PrerequisiteChoice = Pick<RelayTaskListItem, "id" | "title" | "number">;

export function listPrerequisiteChoices(projectId: string, taskId: string, query: string, page: number, signal?: AbortSignal): Promise<{
  tasks: PrerequisiteChoice[]; page?: IssuePagePosition;
}> {
  const params = new URLSearchParams({ view: "prerequisite-choices", projectId, taskId });
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  return apiJson(`/tasks?${params}`, { signal });
}

export function createTask(input: CreateTaskInput): Promise<RelayTask> {
  const { collaborationStyle, ...fields } = input;
  return apiJson<RelayTask>("/tasks", {
    method: "POST",
    body: { ...fields, ...(collaborationStyle ? { collaborationStyle } : {}) },
  });
}

/** A page of a GitHub repository's issues, each marked if already imported. */
export function previewGitHubIssues(query: GitHubIssueQuery, signal?: AbortSignal): Promise<GitHubIssuesResponse> {
  return apiJson<GitHubIssuesResponse>("/tasks/github/issues", { method: "POST", body: query, signal });
}

/** Import the chosen issues as backlog tasks; repeats are skipped server-side. */
export function importGitHubIssues(input: GitHubImportInput): Promise<GitHubImportResponse> {
  return apiJson<GitHubImportResponse>("/tasks/github/import", { method: "POST", body: input });
}

/** One task or routine, by id. The list poll carries most records already,
 *  but a deep link to a record arrives before the list resolves — and an
 *  occurrence may sit outside whatever the list is showing. */
export function getTask(taskId: string, signal: AbortSignal | undefined, view: "record", cache?: PrivateResponseCache<RelayTaskListItem>): Promise<RelayTaskListItem>;
export function getTask(taskId: string, signal?: AbortSignal): Promise<RelayTask>;
export function getTask(taskId: string, signal?: AbortSignal, view?: "record", cache?: PrivateResponseCache<RelayTaskListItem>): Promise<RelayTaskListItem> {
  const path = `/tasks/${encodeURIComponent(taskId)}`;
  if (view === "record") return privateConditionalJson<RelayTaskListItem>(`${path}?view=record`, signal, cache, taskGuard);
  return apiJson(path, { signal, guard: taskGuard });
}

export function getTaskReview(taskId: string, signal?: AbortSignal): Promise<TaskReview> {
  return apiJson<TaskReview>(`/tasks/${encodeURIComponent(taskId)}/review`, { signal, guard: taskReviewGuard });
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
  options: { includeOccurrences?: boolean; view?: "activity" | "lifecycle"; before?: number } = {},
  signal?: AbortSignal,
): Promise<TaskEventsResponse> {
  const params = new URLSearchParams();
  if (options.includeOccurrences) params.set("include", "occurrences");
  if (options.view) params.set("view", options.view);
  if (options.before !== undefined) params.set("before", String(options.before));
  const query = params.toString();
  return apiJson<TaskEventsResponse>(`/tasks/${encodeURIComponent(taskId)}/events${query ? `?${query}` : ""}`, { signal });
}

/**
 * The task's run ledger — one row per run, newest first.
 *
 * A routine's rows are its promoted occurrences; a plain task answers with a
 * single row for its own run.
 */
export function listTaskRuns(
  taskId: string,
  options: { limit?: number; before?: string } = {},
  signal?: AbortSignal,
): Promise<TaskRunsResponse> {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.before) params.set("before", options.before);
  const query = params.toString();
  return apiJson<TaskRunsResponse>(`/tasks/${encodeURIComponent(taskId)}/runs${query ? `?${query}` : ""}`, { signal });
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
