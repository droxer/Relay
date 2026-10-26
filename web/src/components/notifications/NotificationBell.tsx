"use client";

import { useId, useState, type HTMLAttributes, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ActionRemove, ICON, NavNotifications } from "../icons";
import { StateMark } from "../StateMark";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { NotificationsController } from "../../hooks/useNotifications";
import { unreadBadgeText, type NotificationTarget, type NotificationView } from "../../lib/notifications";
import { formatThreadStamp } from "../../lib/threadStamp";

/** Plain left click: the app navigates. Anything else (a new tab, a copied
    link) is the browser's. */
function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
}

export type NotificationBellProps = {
  controller: NotificationsController;
  hrefFor: (target: NotificationTarget) => string;
  settingsHref: string;
  onOpenSettings: () => void;
  /** The trigger's chrome: a rail square on desktop, a top-bar glyph on phones. */
  className?: string;
  variant?: "ghost" | "icon";
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Hover/focus handlers for a host that draws its own hint (the side rail). */
  triggerProps?: Pick<HTMLAttributes<HTMLButtonElement>, "onMouseEnter" | "onMouseLeave" | "onFocus" | "onBlur">;
};

/** The bell's data and destinations; each host (rail, top bar) adds its own chrome. */
export type NotificationBellBinding = Pick<NotificationBellProps, "controller" | "hrefFor" | "settingsHref" | "onOpenSettings">;

/**
 * The inbox bell: an unread count over the glyph, and a panel listing the
 * newest notices. Opening a notice marks it read and goes where it points;
 * a row's dismiss button or "Clear all" removes notices from the inbox.
 * The rail and the phone top bar each mount one, over one shared controller.
 */
export function NotificationBell({
  controller,
  hrefFor,
  settingsHref,
  onOpenSettings,
  className,
  variant = "ghost",
  side = "bottom",
  align = "end",
  triggerProps,
}: NotificationBellProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  // The panel's clock: read when it opens, so a row's "3m ago" holds still
  // while the person reads it.
  const [now, setNow] = useState(0);
  const headingId = useId();
  const { unreadCount } = controller;
  const badge = unreadBadgeText(unreadCount);
  const label = unreadCount > 0
    ? t("notifications.bell_unread", { count: unreadCount })
    : t("notifications.title");

  function onOpenChange(next: boolean) {
    if (next) setNow(Date.now());
    setOpen(next);
  }

  function openNotice(event: MouseEvent<HTMLAnchorElement>, notice: NotificationView) {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    setOpen(false);
    controller.open(notice);
  }

  function openSettings(event: MouseEvent<HTMLAnchorElement>) {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    setOpen(false);
    onOpenSettings();
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant={variant}
            className={`notif-bell ${className ?? ""}`}
            data-nav="notifications"
            data-unread={unreadCount > 0 || undefined}
            aria-label={label}
            {...triggerProps}
          >
            <NavNotifications size={ICON.md} aria-hidden="true" />
            {badge ? <span className="notif-bell-badge tnum" aria-hidden="true">{badge}</span> : null}
          </Button>
        }
      />
      <PopoverContent side={side} align={align} className="notif-panel" aria-labelledby={headingId}>
        <header className="notif-head">
          <h2 id={headingId} className="notif-heading">{t("notifications.title")}</h2>
          <div className="notif-actions">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="notif-mark-all"
              disabled={unreadCount === 0}
              onClick={controller.markAllRead}
            >
              {t("notifications.mark_all_read")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="notif-clear-all"
              disabled={controller.notices.length === 0}
              onClick={controller.clearAll}
            >
              {t("notifications.clear_all")}
            </Button>
          </div>
        </header>
        <NotificationList
          controller={controller}
          hrefFor={hrefFor}
          now={now}
          locale={i18n.language}
          onOpenNotice={openNotice}
        />
        <footer className="notif-foot">
          <a className="notif-settings-link" href={settingsHref} onClick={openSettings}>
            {t("notifications.settings_link")}
          </a>
        </footer>
      </PopoverContent>
    </Popover>
  );
}

function NotificationList({
  controller,
  hrefFor,
  now,
  locale,
  onOpenNotice,
}: {
  controller: NotificationsController;
  hrefFor: (target: NotificationTarget) => string;
  now: number;
  locale: string;
  onOpenNotice: (event: MouseEvent<HTMLAnchorElement>, notice: NotificationView) => void;
}) {
  const { t } = useTranslation();
  const { notices } = controller;
  if (notices.length === 0) {
    const message = controller.isPending
      ? t("notifications.loading")
      : controller.isError
        ? t("notifications.load_failed")
        : t("notifications.empty");
    return <p className="notif-empty" role="status">{message}</p>;
  }
  return (
    <ul className="notif-list">
      {notices.map((notice) => (
        <li key={notice.id} className="notif-item">
          <a
            className="notif-row"
            href={hrefFor(notice.target)}
            data-unread={notice.unread || undefined}
            onClick={(event) => onOpenNotice(event, notice)}
          >
            {/* The row's one dot: toned while unread, settled once read. */}
            <StateMark tone={notice.tone} shape={notice.unread ? undefined : "muted"} className="notif-mark" />
            <span className="notif-copy">
              <span className="notif-title">{t(notice.title.key, notice.title.params)}</span>
              <span className="notif-detail" translate="no">{t(notice.detail.key, notice.detail.params)}</span>
            </span>
            <time className="notif-time tnum" dateTime={notice.createdAt}>
              {formatThreadStamp(notice.createdAt, locale, now)}
            </time>
            {notice.unread ? <span className="sr-only">{t("notifications.unread")}</span> : null}
          </a>
          {/* A sibling of the link, never inside it: a button in an anchor is
              invalid and its click would also follow the link. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="notif-dismiss"
            aria-label={t("notifications.dismiss")}
            title={t("notifications.dismiss")}
            onClick={() => controller.dismiss(notice)}
          >
            <ActionRemove size={ICON.sm} aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
