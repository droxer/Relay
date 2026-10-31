/** Home's recommendations use existing state; dates are local calendar days. */
import type { ProjectRecord, RelayTaskListItem } from "../types.js";
import type { HomeItem } from "./homeQueue.js";
import { isoToday } from "./routine.ts";
import { projectReadOnly } from "./projectPage.ts";

const personal = (task: RelayTaskListItem, userId: string) => (task.assigneeUserId ?? task.ownerUserId) === userId;
const live = (task: RelayTaskListItem) => !task.deletedAt && task.status !== "done";
const priority = { high: 0, normal: 1, low: 2 };
export function readyHomeTasks(tasks: readonly RelayTaskListItem[], projects: readonly ProjectRecord[], userId: string): RelayTaskListItem[] {
  const writable = new Set(projects.filter(p => !projectReadOnly(p)).map(p => p.id));
  return tasks.filter(t => personal(t, userId) && live(t) && !t.isRoutine && !t.sourceRoutineId
    && (t.status === "backlog" || t.status === "assigned") && t.projectId && writable.has(t.projectId)
    && (t.assignedAgentId || t.assignedTeamId) && !t.waitingOn?.length
    && !(t.waitingOn === undefined && t.prerequisiteTaskIds?.length)
    && !t.workspaceWaiting && !t.dispatchClaim && t.dispatchOutcome?.state !== "queued")
    .sort((a,b) => priority[a.priority] - priority[b.priority] || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export interface UpcomingItem { key: string; task: RelayTaskListItem; day: string; kind: "deadline" | "scheduled" | "automation"; }
export function homeUpcoming(tasks: readonly RelayTaskListItem[], userId: string, today: string): UpcomingItem[] {
  const end = new Date(`${today}T12:00:00`); end.setDate(end.getDate()+7);
  const until = isoToday(end);
  return tasks.filter(t => personal(t, userId) && live(t)).flatMap((task): UpcomingItem[] => {
    if (task.isRoutine) {
      if (task.routineState !== "active" || !task.routineNextRunAt || !Number.isFinite(Date.parse(task.routineNextRunAt))) return [];
      return [{key:`automation:${task.id}`,task,day:isoToday(new Date(task.routineNextRunAt)),kind:"automation"}];
    }
    const entries: UpcomingItem[] = [];
    if (task.dueDate) entries.push({key:`due:${task.id}`,task,day:task.dueDate,kind:"deadline"});
    if (task.scheduledFor && !task.startedAt && task.status !== "review") entries.push({key:`scheduled:${task.id}`,task,day:task.scheduledFor,kind:"scheduled"});
    return entries;
  }).filter(r => r.day >= today && r.day < until).sort((a,b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key));
}
export interface HomeBlocker { id: string; summary?: NonNullable<RelayTaskListItem["waitingOnSummaries"]>[number]; dependents: RelayTaskListItem[]; }
export function homeBlockers(tasks: readonly RelayTaskListItem[], userId: string): HomeBlocker[] {
  const rows = new Map<string, HomeBlocker>();
  for (const task of tasks) {
    if (!personal(task, userId) || !live(task) || task.isRoutine) continue;
    for (const id of task.waitingOn ?? []) {
      const summary = task.waitingOnSummaries?.find(s => s.id === id);
      // Personal blockers already have a task row in the action queue.
      if (summary && (summary.assigneeUserId ?? summary.ownerUserId) === userId) continue;
      const row = rows.get(id) ?? {id, summary, dependents: []};
      row.summary ??= summary;
      row.dependents.push(task); rows.set(id,row);
    }
  }
  return [...rows.values()];
}
export function homeFocusItem(items: readonly HomeItem[]): HomeItem | null {
  return items.find(item => item.kind === "permission" || item.kind === "wait" || item.kind === "review" || item.kind === "overdue" || item.kind === "untriaged") ?? null;
}
