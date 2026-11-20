import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  clearNotifications,
  getNotificationPreferences,
  getUnreadNotificationCount,
  listNotifications,
  markNotificationsRead,
  updateNotificationPreferences,
  type NotificationPreferences,
  type NotificationsResponse,
} from "../api";
import {
  DESKTOP_NOTIFICATIONS_CHANGE_EVENT,
  readDesktopNotifications,
  writeDesktopNotifications,
} from "../lib/appStorage";
import {
  desktopBurst,
  newlyArrivedUnread,
  notificationViews,
  type NotificationView,
} from "../lib/notifications";
import { RELAY_POLL_INTERVALS_MS } from "../lib/relayPolling";
import { useMutationError } from "./useMutationError";
import { useAuthSession } from "./useAuthSession";

/* Prefixes for invalidation; each query also includes the login Account id.
   Signing out unmounts the signed-in tree without clearing its query cache. */
export const NOTIFICATIONS_QUERY_KEY = ["relay", "notifications"] as const;
export const NOTIFICATION_PREFERENCES_QUERY_KEY = ["relay", "notification-preferences"] as const;

/* ── Desktop notifications setting ──────────────────────────────────────── */

function subscribeDesktopSetting(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(DESKTOP_NOTIFICATIONS_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DESKTOP_NOTIFICATIONS_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** This browser's desktop-notification choice, shared by the settings toggle
    and the inbox poll. */
export function useDesktopNotificationsSetting(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeDesktopSetting, readDesktopNotifications, () => false);
  return [enabled, writeDesktopNotifications];
}

export type DesktopPermission = NotificationPermission | "unsupported";

/** What the browser allows. Insecure origins and some embedded browsers have
    no `Notification` at all. */
export function desktopPermission(): DesktopPermission {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") return "unsupported";
  return window.Notification.permission;
}

function showDesktopNotices(
  arrivals: NotificationView[],
  t: TFunction,
  onOpen: (notice: NotificationView) => void,
): void {
  const { shown, overflow } = desktopBurst(arrivals);
  const focus = (notification: Notification) => {
    window.focus();
    notification.close();
  };
  try {
    for (const notice of shown) {
      const notification = new window.Notification(t(notice.title.key, notice.title.params), {
        body: t(notice.detail.key, notice.detail.params),
        // A second tab polling the same inbox replaces this notice rather
        // than stacking a duplicate beside it.
        tag: `relay-notification-${notice.id}`,
      });
      notification.onclick = () => {
        focus(notification);
        onOpen(notice);
      };
    }
    if (overflow > 0) {
      const summary = new window.Notification(t("notifications.desktop_more", { count: overflow }), {
        body: t("notifications.desktop_more_body"),
        tag: "relay-notification-summary",
      });
      summary.onclick = () => focus(summary);
    }
  } catch (error) {
    // Some browsers (Android Chrome) allow the permission but refuse the
    // constructor outside a service worker. The in-app inbox still has them.
    console.warn("Desktop notification failed", error);
  }
}

/* ── Inbox ──────────────────────────────────────────────────────────────── */

export type NotificationsController = {
  notices: NotificationView[];
  unreadCount: number;
  /** True until the first read settles. */
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly isFetching: boolean;
  /** Keep the detail query active for an open panel and release it on close. */
  observeInbox: () => () => void;
  retry: () => void;
  markAllRead: () => void;
  /** Empty the inbox. */
  clearAll: () => void;
  /** Remove one notice from the inbox. */
  dismiss: (notice: NotificationView) => void;
  /** Mark the notice read and open what it is about. */
  open: (notice: NotificationView) => void;
};

function withRead(response: NotificationsResponse, ids: ReadonlySet<string> | "all", readAt: string): NotificationsResponse {
  let marked = 0;
  const notifications = response.notifications.map((notice) => {
    if (notice.readAt || (ids !== "all" && !ids.has(notice.id))) return notice;
    marked += 1;
    return { ...notice, readAt };
  });
  return {
    notifications,
    unreadCount: ids === "all" ? 0 : Math.max(0, response.unreadCount - marked),
  };
}

function withoutCleared(response: NotificationsResponse, ids: ReadonlySet<string> | "all"): NotificationsResponse {
  if (ids === "all") return { notifications: [], unreadCount: 0 };
  const removedUnread = response.notifications.filter((notice) => ids.has(notice.id) && !notice.readAt).length;
  return {
    notifications: response.notifications.filter((notice) => !ids.has(notice.id)),
    unreadCount: Math.max(0, response.unreadCount - removedUnread),
  };
}

/**
 * The signed-in person's inbox: polled every 30s and on window focus, with
 * read marks and clears applied to the cache before the server answers. When desktop
 * notifications are on and allowed, a notice that arrives while the page is
 * hidden is also shown by the browser — never the backlog the first read
 * finds.
 */
export function useNotifications({ enabled, onOpen }: {
  enabled: boolean;
  /** Navigate to what a notice is about. */
  onOpen: (notice: NotificationView) => void;
}): NotificationsController {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { reportMutationError } = useMutationError();
  const [desktopEnabled] = useDesktopNotificationsSetting();
  const { user } = useAuthSession();
  const accountId = user?.id;
  const queryKey = useMemo(() => [...NOTIFICATIONS_QUERY_KEY, accountId], [accountId]);
  const countKey = [...queryKey, "count"] as const;
  const [openPanels, setOpenPanels] = useState(0);
  const observeInbox = useCallback(() => {
    setOpenPanels(count => count + 1);
    return () => setOpenPanels(count => count - 1);
  }, []);
  const readDetails = desktopEnabled || openPanels > 0;
  const watching = enabled && Boolean(accountId);

  const count = useQuery({
    queryKey: countKey,
    enabled: watching && !readDetails,
    queryFn: ({ signal }) => getUnreadNotificationCount(signal),
    refetchInterval: RELAY_POLL_INTERVALS_MS.notifications,
    refetchOnWindowFocus: true,
  });

  const query = useQuery({
    queryKey,
    enabled: watching && readDetails,
    queryFn: async ({ signal }) => {
      await queryClient.cancelQueries({ queryKey: countKey, exact: true });
      const countVersion = queryClient.getQueryState(countKey)?.dataUpdateCount;
      const response = await listNotifications(signal);
      // A badge poll can start again if the panel closes mid-fetch. Keep any newer count it read.
      if (!signal.aborted && queryClient.getQueryState(countKey)?.dataUpdateCount === countVersion) {
        queryClient.setQueryData(countKey, { unreadCount: response.unreadCount });
      }
      return response;
    },
    refetchInterval: RELAY_POLL_INTERVALS_MS.notifications,
    // A hidden tab is exactly when a desktop notice is worth showing, so the
    // poll keeps running there — but only for a person who asked for them.
    refetchIntervalInBackground: desktopEnabled,
    refetchOnWindowFocus: true,
  });

  const notices = useMemo(() => notificationViews(query.data?.notifications), [query.data]);
  const unreadCount = count.data?.unreadCount ?? query.data?.unreadCount ?? 0;

  const changeKey = ["notification-change", accountId];
  const reconcileChanges = () => {
    if (queryClient.isMutating({ mutationKey: changeKey }) === 1) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  async function updateInbox(ids: readonly string[] | "all", update: (current: NotificationsResponse) => NotificationsResponse) {
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<NotificationsResponse>(queryKey);
    const optimistic = previous && queryClient.setQueryData<NotificationsResponse>(queryKey, update(previous));
    const previousCount = queryClient.getQueryData<Pick<NotificationsResponse, "unreadCount">>(countKey);
    const optimisticCount = previous && optimistic && queryClient.setQueryData(countKey, {
      unreadCount: ids === "all" ? 0 : Math.max(0, (previousCount?.unreadCount ?? previous.unreadCount)
        - (previous.unreadCount - optimistic.unreadCount)),
    });
    return { previous, optimistic, queryKey, previousCount, optimisticCount, countKey };
  }
  function restoreInbox(context: Awaited<ReturnType<typeof updateInbox>> | undefined) {
    if (context?.previous) {
      queryClient.setQueryData<NotificationsResponse>(context.queryKey, current =>
        current === context.optimistic ? context.previous : current);
    }
    if (context?.previousCount) {
      queryClient.setQueryData<Pick<NotificationsResponse, "unreadCount">>(context.countKey, current =>
        current === context.optimisticCount ? context.previousCount : current);
    }
  }
  const markRead = useMutation({
    mutationKey: changeKey,
    onSettled: reconcileChanges,
    mutationFn: (ids: readonly string[] | "all") => markNotificationsRead(ids),
    onMutate: (ids) => updateInbox(ids, previous => withRead(previous, ids === "all" ? "all" : new Set(ids), new Date().toISOString())),
    onError: (error, _ids, context) => {
      restoreInbox(context);
      reportMutationError("Failed to mark notifications read", error, t("notifications.mark_failed"));
    },
  });
  const { mutate } = markRead;

  const clear = useMutation({
    mutationKey: changeKey,
    onSettled: reconcileChanges,
    mutationFn: (ids: readonly string[] | "all") => clearNotifications(ids),
    onMutate: (ids) => updateInbox(ids, previous => withoutCleared(previous, ids === "all" ? "all" : new Set(ids))),
    onError: (error, _ids, context) => {
      restoreInbox(context);
      reportMutationError("Failed to clear notifications", error, t("notifications.clear_failed"));
    },
  });
  const { mutate: mutateClear } = clear;

  const markAllRead = useCallback(() => mutate("all"), [mutate]);
  const clearAll = useCallback(() => mutateClear("all"), [mutateClear]);
  const dismiss = useCallback((notice: NotificationView) => mutateClear([notice.id]), [mutateClear]);
  const open = useCallback((notice: NotificationView) => {
    if (notice.unread) mutate([notice.id]);
    onOpen(notice);
  }, [mutate, onOpen]);

  /* Ids the previous read returned; null until the first read lands, so that
     read announces nothing. */
  const seenRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => { seenRef.current = null; }, [accountId]);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  useEffect(() => {
    if (!query.data) return;
    const arrivals = newlyArrivedUnread(seenRef.current, notices);
    seenRef.current = new Set(notices.map((notice) => notice.id));
    if (
      arrivals.length === 0
      || !desktopEnabled
      || desktopPermission() !== "granted"
      || typeof document === "undefined"
      || !document.hidden
    ) return;
    showDesktopNotices(arrivals, t, (notice) => openRef.current(notice));
  }, [desktopEnabled, notices, query.data, t]);

  return {
    notices,
    unreadCount,
    get isPending() { return query.isPending; },
    get isError() { return query.isError; },
    get isFetching() { return query.isFetching; },
    observeInbox,
    retry: () => { void query.refetch(); },
    markAllRead,
    clearAll,
    dismiss,
    open,
  };
}

/* ── Preferences ────────────────────────────────────────────────────────── */

/** Which kinds the person mutes, saved as they toggle. */
export function useNotificationPreferences(enabled = true) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { reportMutationError } = useMutationError();
  const { user } = useAuthSession();
  const accountId = user?.id;
  const queryKey = useMemo(() => [...NOTIFICATION_PREFERENCES_QUERY_KEY, accountId], [accountId]);
  // The mutation cache survives leaving and reopening settings mid-save.
  const isSaving = useIsMutating({ mutationKey: queryKey }) > 0;
  const query = useQuery({
    queryKey,
    enabled: enabled && Boolean(accountId),
    queryFn: ({ signal }) => getNotificationPreferences(signal),
  });

  const save = useMutation({
    mutationKey: queryKey,
    mutationFn: (mutedKinds: readonly string[]) => updateNotificationPreferences(mutedKinds),
    onMutate: async (mutedKinds) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<NotificationPreferences>(queryKey);
      if (previous) {
        queryClient.setQueryData<NotificationPreferences>(queryKey, { ...previous, mutedKinds: [...mutedKinds] });
      }
      return { previous, queryKey, accountId };
    },
    onSuccess: (preferences, _muted, context) => {
      queryClient.setQueryData(context.queryKey, preferences);
      // Muting hides a kind from the inbox server-side; re-read it now.
      void queryClient.invalidateQueries({ queryKey: [...NOTIFICATIONS_QUERY_KEY, context.accountId] });
    },
    onError: (error, _muted, context) => {
      if (context?.previous) queryClient.setQueryData(context.queryKey, context.previous);
      reportMutationError("Failed to save notification preferences", error, t("notifications.prefs_failed"));
    },
  });
  const { mutate } = save;

  const preferences = query.data;
  const setKindEnabled = useCallback((kind: string, on: boolean) => {
    // Read synchronously too, before React has rendered disabled switches.
    if (queryClient.isMutating({ mutationKey: queryKey }) || !accountId || !preferences) return;
    const muted = preferences.mutedKinds;
    const next = on ? muted.filter((item) => item !== kind) : [...new Set([...muted, kind])];
    mutate(next);
  }, [mutate, preferences, accountId, queryClient, queryKey]);

  return {
    preferences,
    get isPending() { return query.isPending; },
    get isError() { return query.isError; },
    get isFetching() { return query.isFetching; },
    retry: () => { void query.refetch(); },
    isSaving,
    setKindEnabled,
  };
}
