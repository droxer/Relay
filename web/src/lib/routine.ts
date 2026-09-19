import { TASK_PRIORITIES } from "./backlog.ts";
import { byDate, byRank, byText, type SortColumn } from "./listSort.ts";
import type { RelaySession, RelayTaskListItem, TaskRoutineCadence, TaskRoutineType } from "../types.js";

export const TASK_ROUTINE_TYPES: TaskRoutineType[] = ["task", "job"];
export const TASK_ROUTINE_CADENCES: TaskRoutineCadence[] = ["daily", "weekly", "monthly", "custom"];

export interface RoutineFilters {
  query: string;
  type: "all" | TaskRoutineType;
  cadence: "all" | TaskRoutineCadence;
  agent: string;
  assignee: string;
  state: "all" | RoutineState;
}

export function filterRoutineTasks(tasks: RelayTaskListItem[], filters: RoutineFilters, today = isoToday()): RelayTaskListItem[] {
  const query = filters.query.trim().toLowerCase();
  const assignee = filters.assignee.trim().toLowerCase();
  const running = runningRoutineIds(tasks);
  return tasks.filter((task) => {
    if (!task.isRoutine) return false;
    if (filters.type !== "all" && task.routineType !== filters.type) return false;
    if (filters.cadence !== "all" && task.routineCadence !== filters.cadence) return false;
    if (filters.agent !== "all" && task.assignedAgentId !== filters.agent) return false;
    if (assignee && !(task.assigneeEmployeeId ?? task.ownerEmployeeId ?? "").toLowerCase().includes(assignee)) return false;
    if (filters.state !== "all" && routineState(task, running, today) !== filters.state) return false;
    if (query) {
      const haystack = `${task.title} ${task.description} ${task.id}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  }).sort(compareRoutineTasks);
}

/**
 * Routine state is *schedule health*, not backlog lifecycle. A routine
 * definition never moves through the board, so its own `status` field stays
 * at whatever it was created with — surfaces that render it are showing
 * noise. Every routine surface derives state from the three facts that
 * actually vary: is an occurrence executing right now, is the schedule on,
 * and where does the next run date sit relative to today.
 */
export type RoutineState =
  | "running"
  | "overdue"
  | "due"
  | "unscheduled"
  | "scheduled"
  | "paused";

/**
 * Routines whose latest occurrence is still in flight. `running` outranks
 * `paused`: pausing a schedule stops future dispatches, it does not abort the
 * run already underway, and a live run is the more urgent fact to show.
 */
export function routineState(
  routine: RelayTaskListItem,
  running: ReadonlySet<string>,
  today = isoToday(),
): RoutineState {
  if (running.has(routine.id)) return "running";
  if (!routine.routineEnabled) return "paused";
  if (!routine.routineNextRunDate) return "unscheduled";
  if (routine.routineNextRunDate < today) return "overdue";
  if (routine.routineNextRunDate === today) return "due";
  return "scheduled";
}

/**
 * Schedule urgency, most urgent first — the order the state column sorts by.
 * It is not the order `RoutineState` happens to be declared in: that union
 * lists the states, this ranks them. A live run outranks an overdue schedule
 * because it is the thing you can still act on.
 */
export const ROUTINE_STATE_ORDER: readonly RoutineState[] = [
  "running",
  "overdue",
  "due",
  "scheduled",
  "unscheduled",
  "paused",
];

/**
 * How many routines sit in each schedule state, in `ROUTINE_STATE_ORDER` —
 * the numbers the board's section rail carries beside each section name.
 *
 * Every state is present even at zero: the rail names its sections whether or
 * not anything is in them, and a rail that dropped its empty rows would
 * reshuffle under the pointer as the search box narrowed the board.
 *
 * The state is DERIVED, so the running set has to come from the same place
 * the rows read it from or a routine is counted under a state its own row
 * denies.
 */
export function routineStateCounts(
  routines: RelayTaskListItem[],
  running: ReadonlySet<string>,
  today = isoToday(),
): Record<RoutineState, number> {
  const counts = Object.fromEntries(
    ROUTINE_STATE_ORDER.map((state) => [state, 0]),
  ) as Record<RoutineState, number>;
  for (const routine of routines) counts[routineState(routine, running, today)] += 1;
  return counts;
}

/** The keys the routine list's sortable column headers speak. */
export type RoutineSortKey = "title" | "priority" | "assignee" | "nextRun";

/**
 * Sortable columns for the routine list, in header order.
 *
 * Schedule state is NOT among them: the rail beside the list owns that
 * dimension, and the list's state cell is a dot with no header above it, so a
 * state order would be an active sort no control on the surface could show or
 * undo. The default order (`compareRoutineTasks`) already runs urgency-first,
 * which is what a state sort was reaching for.
 */
export function routineSortColumns(
  assigneeName: (task: RelayTaskListItem) => string,
): readonly SortColumn<RelayTaskListItem, RoutineSortKey>[] {
  return [
    { key: "title", compare: byText((task) => task.title) },
    { key: "priority", compare: byRank((task) => task.priority, TASK_PRIORITIES) },
    {
      key: "assignee",
      compare: byText(assigneeName),
      isMissing: (task) => !assigneeName(task).trim(),
    },
    {
      key: "nextRun",
      compare: byDate((task) => task.routineNextRunDate),
      isMissing: (task) => !task.routineNextRunDate,
    },
  ];
}

export function routineDueTone(task: RelayTaskListItem, today = isoToday()): "neutral" | "warn" | "bad" {
  if (!task.routineEnabled || !task.routineNextRunDate) return "neutral";
  if (task.routineNextRunDate < today) return "bad";
  if (task.routineNextRunDate === today) return "warn";
  return "neutral";
}

export function latestRoutineSession(
  routine: RelayTaskListItem,
  tasks: RelayTaskListItem[],
  sessions: RelaySession[],
): RelaySession | undefined {
  const occurrenceIds = new Set(routine.occurrenceIds ?? []);
  const occurrences = tasks
    .filter((task) => occurrenceIds.has(task.id) || task.sourceRoutineId === routine.id)
    .sort((left, right) =>
      (left.scheduledFor ?? left.createdAt).localeCompare(
        right.scheduledFor ?? right.createdAt,
      ) || left.createdAt.localeCompare(right.createdAt),
    );
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const linkedIds = [
    ...routine.linkedSessionIds,
    ...occurrences.flatMap((occurrence) => occurrence.linkedSessionIds),
  ];
  return [...linkedIds].reverse().map((id) => sessionById.get(id)).find(Boolean);
}

/**
 * Ids of routines with an occurrence in flight. Derived once per render and
 * passed to `routineState` so a board of N routines stays O(tasks) rather
 * than re-scanning the task list per card.
 */
export function runningRoutineIds(tasks: RelayTaskListItem[]): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.isRoutine) continue;
    if (!task.sourceRoutineId) continue;
    if (task.status !== "running" && task.status !== "review") continue;
    ids.add(task.sourceRoutineId);
  }
  return ids;
}

function compareRoutineTasks(left: RelayTaskListItem, right: RelayTaskListItem): number {
  return enabledRank(left) - enabledRank(right)
    || routineDate(left).localeCompare(routineDate(right))
    || right.updatedAt.localeCompare(left.updatedAt);
}

function enabledRank(task: RelayTaskListItem): number {
  return task.routineEnabled ? 0 : 1;
}

function routineDate(task: RelayTaskListItem): string {
  return task.routineNextRunDate ?? "9999-12-31";
}

export function isoToday(date = new Date()): string {
  // Local-date key, not UTC — routine next-run dates are calendar days, so
  // toISOString() (UTC) flips "today" a day early/late for users far from UTC.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
