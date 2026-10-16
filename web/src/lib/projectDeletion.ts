/**
 * What a person is told after deleting a project, or after a refusal.
 *
 * The backend (`backend/relay/services/project_deletion.py`) decides what
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

/** How many threads a refusal names before summarizing the rest. */
const NAMED_THREAD_LIMIT = 3;

function blockingSessionIds(detail: unknown): string[] {
  if (!detail || typeof detail !== "object" || !("sessionIds" in detail)) return [];
  const ids = (detail as { sessionIds: unknown }).sessionIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The message for a refused delete. `threadName` resolves a blocking thread id
 * to its label, or undefined when that thread is not loaded.
 */
export function projectDeleteErrorMessage(
  error: unknown,
  threadName: (sessionId: string) => string | undefined,
): Omit<ProjectMessage, "tone"> {
  const code = error instanceof RelayApiError ? error.code ?? error.message : error instanceof Error ? error.message : "";
  if (code === "project_version_conflict") return { key: "project.delete_conflict" };
  if (code === "project_cleanup_queue_full") return { key: "project.delete_queue_full" };
  if (!code.includes("project_execution_active")) return { key: "errors.delete_project" };
  const names = blockingSessionIds(error instanceof RelayApiError ? error.detail : undefined)
    .map(threadName)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return { key: "project.delete_active" };
  const shown = names.slice(0, NAMED_THREAD_LIMIT).join(", ");
  const more = names.length - NAMED_THREAD_LIMIT;
  return more > 0
    ? { key: "project.delete_active_threads_more", values: { threads: shown, count: more } }
    : { key: "project.delete_active_threads", values: { threads: shown } };
}
