import { apiJson } from "./client.ts";

/** The kinds this build knows how to render. A server may send others; the
    inbox reads them through `notificationView`, which skips what it cannot
    name. */
export const NOTIFICATION_KINDS = ["task_completed", "computer_status", "client_outdated"] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** One notice as the server stores it. `data` carries facts (ids, names,
    statuses), never prose, and is untrusted: parse it with
    `notificationView` before reading a field. `kind` is a plain string for
    the same reason — a newer server may add one. */
export interface RelayNotification {
  id: string;
  kind: string;
  data: unknown;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsResponse {
  notifications: RelayNotification[];
  unreadCount: number;
}

export interface NotificationPreferences {
  mutedKinds: string[];
  /** Every kind the server can send, muted or not. */
  kinds: string[];
}

/** Newest first; muted kinds are already left out by the server. */
export function listNotifications(signal?: AbortSignal, limit = 50): Promise<NotificationsResponse> {
  return apiJson<NotificationsResponse>(`/notifications?limit=${limit}`, { signal });
}

/** Mark the named notices read, or every notice with `"all"`. Ids that are
    not the caller's are ignored by the server. */
export function markNotificationsRead(target: readonly string[] | "all"): Promise<{ unreadCount: number }> {
  return apiJson<{ unreadCount: number }>("/notifications/read", {
    method: "POST",
    body: target === "all" ? { all: true } : { ids: [...target] },
  });
}

export function getNotificationPreferences(signal?: AbortSignal): Promise<NotificationPreferences> {
  return apiJson<NotificationPreferences>("/notifications/preferences", { signal });
}

export function updateNotificationPreferences(mutedKinds: readonly string[]): Promise<NotificationPreferences> {
  return apiJson<NotificationPreferences>("/notifications/preferences", {
    method: "PUT",
    body: { mutedKinds: [...mutedKinds] },
  });
}
