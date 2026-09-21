/**
 * The task board's shared vocabulary — the pieces the page, its chrome, and
 * its record renderers all have to agree on.
 *
 * Extracted when BacklogPage.tsx was split at 971 lines. These are exactly the
 * bindings that crossed the new seams; leaving them in the page would have
 * meant the chrome and the records importing from the component that renders
 * them, which is the wrong direction.
 */
import { TASK_PRIORITIES, TASK_STATUSES, type BacklogFilters } from "../../lib/backlog";
import type { TaskStatus } from "../../types";
import type { StateShape } from "../StateMark";
import { readViewPreference } from "../../lib/viewPreference";
import type { FilterSpec } from "../../lib/urlFilters";

/**
 * Lifecycle status in the shared shape vocabulary (see StateMark). The row
 * rail and the status column read the same accent, so the 8px mark at the far
 * left and the word 150px away are no longer two unrelated signals.
 */
export const TASK_STATUS_SHAPE: Record<TaskStatus, StateShape> = {
  backlog: "dashed",
  assigned: "solid",
  running: "live",
  waiting_for_human: "solid",
  review: "solid",
  blocked: "ring",
  done: "muted",
};

export const initialFilters: BacklogFilters = {
  query: "",
  status: "all",
  priority: "all",
  agent: "all",
  team: "all",
  assignment: "all",
  assignee: "",
  due: "all",
  source: "all",
};

/* The query params the backlog filter bar owns — must stay in sync with
   LIST_FILTER_PARAMS.backlog in lib/appRoute.ts, which decides which of these
   survive canonicalization. */
export const BACKLOG_FILTER_SPEC: FilterSpec<BacklogFilters> = {
  query: { param: "q" },
  status: { param: "status", allowed: TASK_STATUSES },
  priority: { param: "priority", allowed: TASK_PRIORITIES },
  agent: { param: "agent" },
  team: { param: "team" },
  assignment: { param: "assignment", allowed: ["assigned", "unassigned"] },
  assignee: { param: "assignee" },
  due: { param: "due", allowed: ["overdue", "today", "next_week", "unscheduled"] },
  source: { param: "source", allowed: ["direct", "routine"] },
};

export type BacklogView = "board" | "list";

export const VIEW_STORAGE_KEY = "relay-web.backlogView";
export const BACKLOG_VIEWS: readonly BacklogView[] = ["board", "list"];

export function parseBacklogView(value: string | null): BacklogView {
  return BACKLOG_VIEWS.includes(value as BacklogView)
    ? value as BacklogView
    : readViewPreference(VIEW_STORAGE_KEY, "list", BACKLOG_VIEWS);
}

export function activeFilterCount(filters: BacklogFilters): number {
  let count = 0;
  if (filters.status !== "all") count += 1;
  if (filters.priority !== "all") count += 1;
  if (filters.agent !== "all") count += 1;
  if (filters.team !== "all") count += 1;
  if (filters.assignment !== "all") count += 1;
  if (filters.assignee.trim()) count += 1;
  if (filters.due !== "all") count += 1;
  if (filters.source !== "all") count += 1;
  return count;
}
