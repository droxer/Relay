/* The notification inbox, as the web reads it.

   A notice carries facts — ids, names, statuses — and never prose, so the
   reader's language renders it. Its `data` is untrusted: an older or newer
   server may send a kind this build cannot name, or a field in another shape.
   `notificationView` is the one seam that turns a stored notice into
   something a row can render, and it answers `null` for anything it cannot
   read, so the inbox skips that notice rather than printing half of one. */

import type { NotificationKind, RelayNotification } from "../api-client/notifications.ts";
import type { Tone } from "../domain-types/core.ts";
import { pathForAppState, type AppLocationState } from "./appRoute.ts";
import { taskRef } from "./taskRef.ts";

/** Where opening a notice takes the reader. A computer resolves to a surface
    only at click time, because which surface manages it depends on who owns
    it (`computerManagementDestination`). */
export type NotificationTarget =
  | { kind: "task"; taskId: string; routineId: string | null }
  | { kind: "computer"; nodeId: string };

/** i18n key plus its interpolation values. */
export type NotificationText = { key: string; params: Record<string, string | number> };

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  unread: boolean;
  createdAt: string;
  tone: Tone;
  /** What happened: "Ready for review", "Computer went offline". */
  title: NotificationText;
  /** What it happened to: the task ref and title, the computer's name. */
  detail: NotificationText;
  target: NotificationTarget;
}

/** The unread badge stops counting here; past it the badge reads "9+". */
export const UNREAD_BADGE_CAP = 9;

/** A burst of arrivals shows at most this many desktop notices; the rest
    fold into one summary so a backlog never fills the screen. */
export const DESKTOP_BURST_CAP = 3;

type Data = Record<string, unknown>;

function record(value: unknown): Data | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Data : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function presence(value: unknown): "online" | "offline" | null {
  return value === "online" || value === "offline" ? value : null;
}

type Body = Pick<NotificationView, "tone" | "title" | "detail" | "target">;

function taskCompleted(data: Data): Body | null {
  const taskId = text(data.taskId);
  const status = data.status;
  if (!taskId || (status !== "review" && status !== "done")) return null;
  const number = typeof data.number === "number" && Number.isInteger(data.number) ? data.number : undefined;
  // An occurrence of an automation is still an issue-style task: `#12`, never
  // `AUTO-12`. Only its address differs — it opens as a run of its routine.
  const ref = taskRef({ id: taskId, number });
  const title = text(data.title);
  return {
    tone: status === "review" ? "info" : "good",
    title: { key: status === "review" ? "notifications.task_review" : "notifications.task_done", params: {} },
    detail: title
      ? { key: "notifications.task_detail", params: { ref, title } }
      : { key: "notifications.task_detail_untitled", params: { ref } },
    target: { kind: "task", taskId, routineId: text(data.sourceRoutineId) },
  };
}

function computerName(data: Data, nodeId: string): string {
  return text(data.computerName) ?? nodeId;
}

function computerStatus(data: Data): Body | null {
  const nodeId = text(data.nodeId);
  const to = presence(data.to);
  if (!nodeId || !to) return null;
  return {
    tone: to === "online" ? "good" : "warn",
    title: { key: to === "online" ? "notifications.computer_online" : "notifications.computer_offline", params: {} },
    detail: { key: "notifications.computer_detail", params: { name: computerName(data, nodeId) } },
    target: { kind: "computer", nodeId },
  };
}

function clientOutdated(data: Data): Body | null {
  const nodeId = text(data.nodeId);
  if (!nodeId) return null;
  return {
    tone: "warn",
    title: { key: "notifications.client_outdated", params: {} },
    detail: { key: "notifications.client_outdated_detail", params: { name: computerName(data, nodeId) } },
    target: { kind: "computer", nodeId },
  };
}

const READERS: Record<NotificationKind, (data: Data) => Body | null> = {
  task_completed: taskCompleted,
  computer_status: computerStatus,
  client_outdated: clientOutdated,
};

function isKnownKind(kind: unknown): kind is NotificationKind {
  return typeof kind === "string" && Object.prototype.hasOwnProperty.call(READERS, kind);
}

/** One stored notice → what a row renders, or `null` when it cannot be read. */
export function notificationView(value: unknown): NotificationView | null {
  const notice = record(value);
  if (!notice) return null;
  const id = text(notice.id);
  const createdAt = text(notice.createdAt);
  if (!id || !createdAt || !isKnownKind(notice.kind)) return null;
  const data = record(notice.data);
  const body = data ? READERS[notice.kind](data) : null;
  if (!body) return null;
  return { id, kind: notice.kind, unread: !text(notice.readAt), createdAt, ...body };
}

/** Every readable notice, in the server's (newest-first) order. */
export function notificationViews(notices: readonly RelayNotification[] | unknown): NotificationView[] {
  if (!Array.isArray(notices)) return [];
  return notices.flatMap((notice) => {
    const view = notificationView(notice);
    return view ? [view] : [];
  });
}

/** The badge's text: the count, capped at "9+"; empty when nothing is unread. */
export function unreadBadgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(Math.floor(count));
}

/** The unread notices in `fresh` that were not there before.

    `seen` is every id the previous read returned; `null` means there was no
    previous read. The first read of a session therefore announces nothing —
    the backlog a person comes back to is not news, and a desktop notice per
    old notice would bury the screen. */
export function newlyArrivedUnread(
  seen: ReadonlySet<string> | null,
  fresh: readonly NotificationView[],
): NotificationView[] {
  if (!seen) return [];
  return fresh.filter((notice) => notice.unread && !seen.has(notice.id));
}

/** Split arrivals into the ones shown one by one and the count folded into a
    summary. Newest first, as the server orders them. */
export function desktopBurst(
  arrivals: readonly NotificationView[],
  cap = DESKTOP_BURST_CAP,
): { shown: NotificationView[]; overflow: number } {
  return { shown: arrivals.slice(0, cap), overflow: Math.max(0, arrivals.length - cap) };
}

/** Which surface manages a computer. */
export type ComputerDestination = "computers" | "admin";

/** Which surface manages a computer: the person's own Computers page for a
    computer they hold, the control panel for one they reach as an admin.
    An admin is told about shared hardware no user holds, which only the
    control panel lists. */
export function computerManagementDestination(
  nodeId: string,
  { isAdmin, ownNodeIds }: { isAdmin: boolean; ownNodeIds: ReadonlySet<string> },
): ComputerDestination {
  if (ownNodeIds.has(nodeId)) return "computers";
  return isAdmin ? "admin" : "computers";
}

/** The app location a notice opens. */
export function notificationLocation(
  target: NotificationTarget,
  computerDestination: ComputerDestination = "computers",
): AppLocationState {
  if (target.kind === "task") {
    return target.routineId
      ? { route: "routine", mobileView: "chat", sessionId: null, taskId: target.routineId, runId: target.taskId }
      : { route: "backlog", mobileView: "chat", sessionId: null, taskId: target.taskId };
  }
  return computerDestination === "admin"
    ? { route: "admin", mobileView: "chat", sessionId: null, adminSection: "computers" }
    : { route: "computers", mobileView: "chat", sessionId: null };
}

export function notificationHref(
  target: NotificationTarget,
  computerDestination: ComputerDestination = "computers",
): string {
  return pathForAppState(notificationLocation(target, computerDestination));
}
