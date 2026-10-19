import { triggersOf } from "./automationTrigger.ts";
import { taskRef } from "./taskRef.ts";
import { matchesTagFilter } from "./taskTags.ts";
import { TASK_PRIORITIES } from "./backlog.ts";
import { byDate, byRank, byText, type SortColumn } from "./listSort.ts";
import type { RelaySession, RelayTaskListItem, RoutineTriggerKind } from "../types.js";

export interface RoutineFilters {
  /** `none` is a Run-now-only automation: one with no triggers. */
  trigger: "all" | "none" | RoutineTriggerKind;
  query: string;
  /** One tag the automation must carry; `all` for any. */
  tag: string;
  agent: string;
  assignee: string;
  state: "all" | RoutineListState;
}

export function filterRoutineTasks(tasks: RelayTaskListItem[], filters: RoutineFilters, now = new Date()): RelayTaskListItem[] {
  const query = filters.query.trim().toLowerCase();
  const assignee = filters.assignee.trim().toLowerCase();
  const running = runningRoutineIds(tasks);
  return tasks.filter((task) => {
    if (!task.isRoutine) return false;
    if (!matchesTriggerFilter(task, filters.trigger)) return false;
    if (filters.agent !== "all" && task.assignedAgentId !== filters.agent) return false;
    if (!matchesTagFilter(task, filters.tag)) return false;
    if (assignee && !(task.assigneeUserId ?? task.ownerUserId ?? "").toLowerCase().includes(assignee)) return false;
    if (filters.state !== "all" && routineState(task, running, now) !== filters.state) return false;
    if (query) {
      const haystack = `${taskRef(task)} ${task.title} ${task.description} ${task.id} ${(task.tags ?? []).join(" ")}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  }).sort(compareRoutineTasks);
}

function matchesTriggerFilter(task: RelayTaskListItem, filter: RoutineFilters["trigger"]): boolean {
  if (filter === "all") return true;
  const triggers = triggersOf(task);
  if (filter === "none") return triggers.length === 0;
  return triggers.some((trigger) => trigger.kind === filter);
}

/**
 * The list's state is *schedule health*, not backlog lifecycle. An automation
 * definition never moves through the board, so its own `status` field stays
 * at whatever it was created with — surfaces that render it are showing
 * noise. Every automation surface derives state from the facts that actually
 * vary: is an occurrence executing right now, is it on, what starts it, and
 * when its next scheduled run is. Not the wire `RoutineState`, which is only
 * the on/off half of it.
 */
export type RoutineListState =
  | "running"
  | "due"
  | "listening"
  | "on_demand"
  | "scheduled"
  | "paused";

/**
 * Automations whose latest occurrence is still in flight. `running` outranks
 * `paused`: pausing stops future dispatches, it does not abort the run
 * already underway, and a live run is the more urgent fact to show.
 */
export function routineState(
  routine: RelayTaskListItem,
  running: ReadonlySet<string>,
  now = new Date(),
): RoutineListState {
  if (running.has(routine.id)) return "running";
  if (routine.routineState !== "active") return "paused";
  const triggers = triggersOf(routine);
  const next = routine.routineNextRunAt;
  if (!next && triggers.some((trigger) => trigger.kind !== "schedule")) return "listening";
  /* A Run-now-only automation watches for nothing; "Listening" would say it does. */
  if (triggers.length === 0) return "on_demand";
  // A completed one-off has no future automatic run, but Run now still works.
  if (!next && triggers.every((trigger) => trigger.kind === "schedule" && "once" in trigger.schedule.repeat)) {
    return "on_demand";
  }
  if (next && Date.parse(next) <= now.getTime()) return "due";
  return "scheduled";
}

/** Run now works in every state but a rate-limit pause, which it would only defeat. */
export function runNowRefused(routine: Pick<RelayTaskListItem, "routineState" | "routinePauseReason">): boolean {
  return routine.routineState === "paused_by_relay" && routine.routinePauseReason === "rate_limited";
}

/**
 * Schedule urgency, most urgent first — the order the state column sorts by.
 * It is not the order `RoutineListState` happens to be declared in: that union
 * lists the states, this ranks them. A live run outranks a due schedule
 * because it is the thing you can still act on.
 */
export const ROUTINE_STATE_ORDER: readonly RoutineListState[] = [
  "running",
  "due",
  "scheduled",
  "listening",
  "on_demand",
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
  now = new Date(),
): Record<RoutineListState, number> {
  const counts = Object.fromEntries(
    ROUTINE_STATE_ORDER.map((state) => [state, 0]),
  ) as Record<RoutineListState, number>;
  for (const routine of routines) counts[routineState(routine, running, now)] += 1;
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
      compare: byDate((task) => task.routineNextRunAt),
      isMissing: (task) => !task.routineNextRunAt,
    },
  ];
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
  return task.routineState === "active" ? 0 : 1;
}

function routineDate(task: RelayTaskListItem): string {
  return task.routineNextRunAt ?? "9999-12-31";
}

export function isoToday(date = new Date()): string {
  // Local-date key, not UTC — routine next-run dates are calendar days, so
  // toISOString() (UTC) flips "today" a day early/late for users far from UTC.
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
