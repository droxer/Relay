import type { AgentName } from "../types.js";
import { agentLabel } from "./plan.ts";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Compact "Mon D, HH:MM" timestamp for workspace rows. Shared by the agent
 *  and team workspace surfaces. Returns "" for empty and the raw value for
 *  unparseable input. */
export function compactDate(value: string | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale || undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Compact "Mon D" for a date-only field (`RelayTask.dueDate`, "2026-07-28").
 *  Never renders a time: the value has none, and `new Date("2026-07-28")`
 *  parses as UTC midnight, which invents a clock reading and shifts the day
 *  backwards for viewers west of UTC. Parsed as a local date instead, matching
 *  `formatDueDate` on the backlog. */
export function compactDueDate(value: string | undefined, locale: string): string {
  if (!value) return "";
  const parts = DATE_ONLY.exec(value);
  const date = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale || undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

/** Display name for a brief task's assignee: the logical agent's displayName
 *  when the roster is at hand, the executor CLI label when only the runtime
 *  kind is known, and "" when nothing is assigned — the caller supplies the
 *  localized "unassigned" fallback. */
export function taskAssigneeName(
  task: { assignedAgentId?: string; assignedAgent?: AgentName },
  agents: ReadonlyArray<{ id: string; displayName: string }> | undefined,
): string {
  if (task.assignedAgentId) {
    const match = agents?.find((agent) => agent.id === task.assignedAgentId);
    if (match) return match.displayName;
  }
  return task.assignedAgent ? agentLabel(task.assignedAgent) : "";
}

/** The containing directory of a workspace path ("" for a top-level entry). */
export function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

/** Byte count as a compact human size ("" when the size is unknown). */
export function formatBytes(bytes: number | null | undefined, locale?: string): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${new Intl.NumberFormat(locale || undefined).format(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${new Intl.NumberFormat(locale || undefined, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value)} ${unit}`;
}
