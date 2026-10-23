/**
 * What a person is told after deleting a project, or after a refusal.
 *
 * The backend (`backend/relay/projects/deletion.py`) decides what
 * happens to the workspace files and which threads block the delete; this
 * module only turns those answers into message keys.
 */
import { RelayApiError } from "../api-client/client.ts";
import type { ProjectWorkspaceCleanup } from "../api-client/projects.ts";

export interface ProjectMessage {
  key: string;
  values?: Record<string, string | number>;
  tone: "info" | "warn";
}

const CLEANUP_NOTICE: Record<ProjectWorkspaceCleanup, ProjectMessage> = {
  queued: { key: "project.cleanup_queued", tone: "info" },
  kept: { key: "project.cleanup_kept", tone: "info" },
  waiting_for_upgrade: { key: "project.cleanup_waiting_for_upgrade", tone: "warn" },
  waiting_for_computer: { key: "project.cleanup_waiting_for_computer", tone: "warn" },
  orphaned: { key: "project.cleanup_orphaned", tone: "warn" },
};

export function projectCleanupNotice(cleanup: ProjectWorkspaceCleanup): ProjectMessage {
  return CLEANUP_NOTICE[cleanup] ?? CLEANUP_NOTICE.queued;
}

/** How many threads or tasks a refusal names before summarizing the rest. */
const NAMED_LIMIT = 3;

function blockingIds(detail: unknown, field: "sessionIds" | "taskIds"): string[] {
  if (!detail || typeof detail !== "object" || !(field in detail)) return [];
  const ids = (detail as Record<string, unknown>)[field];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function namedRefusal(names: string[], prefix: string, valueKey: string): Omit<ProjectMessage, "tone"> {
  const shown = names.slice(0, NAMED_LIMIT).join(", ");
  const more = names.length - NAMED_LIMIT;
  return more > 0
    ? { key: `${prefix}_more`, values: { [valueKey]: shown, count: more } }
    : { key: prefix, values: { [valueKey]: shown } };
}

/**
 * The message for a refused delete. `threadName` and `taskName` resolve a
 * blocking thread or task id to its label, or undefined when it is not
 * loaded. Threads are named first; a refusal whose threads sit outside what
 * the page loaded falls back to the tasks holding them.
 */
export function projectDeleteErrorMessage(
  error: unknown,
  threadName: (sessionId: string) => string | undefined,
  taskName: (taskId: string) => string | undefined = () => undefined,
): Omit<ProjectMessage, "tone"> {
  const code = error instanceof RelayApiError ? error.code ?? error.message : error instanceof Error ? error.message : "";
  if (code === "project_version_conflict") return { key: "project.delete_conflict" };
  if (code === "project_cleanup_queue_full") return { key: "project.delete_queue_full" };
  if (!code.includes("project_execution_active")) return { key: "errors.delete_project" };
  const detail = error instanceof RelayApiError ? error.detail : undefined;
  const named = (ids: string[], name: (id: string) => string | undefined) =>
    ids.map(name).filter((label): label is string => Boolean(label));
  const threads = named(blockingIds(detail, "sessionIds"), threadName);
  if (threads.length > 0) return namedRefusal(threads, "project.delete_active_threads", "threads");
  const tasks = named(blockingIds(detail, "taskIds"), taskName);
  if (tasks.length > 0) return namedRefusal(tasks, "project.delete_active_tasks", "tasks");
  return { key: "project.delete_active" };
}
