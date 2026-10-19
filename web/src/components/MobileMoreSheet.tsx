"use client";

import { useRef, useState, type ComponentType, type MouseEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from "@/components/ui/dialog";
import { ActionSearch, CheckIcon, ICON, NavLogout, type GlyphProps } from "./icons";
import type { AppRoute } from "../lib/viewTypes";

/** How far a drag on the grabber must travel before letting go dismisses the
 *  sheet. Shorter drags spring back, as a native sheet does. */
const DISMISS_DRAG_PX = 80;

export type MoreSheetRoute = {
  route: AppRoute;
  Icon: ComponentType<GlyphProps>;
  labelKey: string;
};

/** The phone tab bar's More destination, as a bottom sheet rather than a
 *  popover: the pattern a thumb expects from the bar it was opened from, and
 *  the one Linear's mobile app uses. Rows are grouped by job — where to go,
 *  what to do, the account — and every row is a full-width 48px target. The
 *  Dialog primitive supplies the scrim, the focus trap, Escape, and focus
 *  restore to the More tab. */
export function MobileMoreSheet({
  open,
  onOpenChange,
  routes,
  currentRoute,
  hrefForRoute,
  onNavigate,
  onSearch,
  onboarding,
  onOpenOnboarding,
  onLogout,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routes: readonly MoreSheetRoute[];
  currentRoute: AppRoute;
  hrefForRoute: (route: AppRoute) => string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, route: AppRoute) => void;
  onSearch: () => void;
  onboarding: { done: number; total: number } | null;
  onOpenOnboarding?: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const [dragY, setDragY] = useState(0);
  const dragStart = useRef<number | null>(null);

  function close() {
    onOpenChange(false);
  }

  /* Each action closes the sheet first, so focus restore lands on the More
     tab before the next surface (the palette, the wizard) takes it. */
  function runThenClose(action: () => void) {
    close();
    action();
  }

  function onGrabStart(event: PointerEvent<HTMLDivElement>) {
    dragStart.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onGrabMove(event: PointerEvent<HTMLDivElement>) {
    if (dragStart.current === null) return;
    setDragY(Math.max(0, event.clientY - dragStart.current));
  }

  function onGrabEnd() {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (dragY > DISMISS_DRAG_PX) close();
    setDragY(0);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogBackdrop className="more-sheet-backdrop" />
        <DialogViewport className="more-sheet-viewport">
          <DialogContent
            className="more-sheet"
            data-dragging={dragY > 0 || undefined}
            style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
          >
            <div
              className="more-sheet-grab"
              aria-hidden="true"
              onPointerDown={onGrabStart}
              onPointerMove={onGrabMove}
              onPointerUp={onGrabEnd}
              onPointerCancel={onGrabEnd}
            >
              <span className="more-sheet-grabber" />
            </div>
            <DialogTitle className="more-sheet-title">{t("nav.more")}</DialogTitle>

            <nav aria-label={t("nav.more_label")}>
              <ul className="more-sheet-group">
                {routes.map(({ route, Icon, labelKey }) => {
                  const current = route === currentRoute;
                  return (
                    <li key={route}>
                      <a
                        className="more-sheet-row"
                        href={hrefForRoute(route)}
                        aria-current={current ? "page" : undefined}
                        onClick={(event) => {
                          onNavigate(event, route);
                          close();
                        }}
                      >
                        <Icon size={ICON.lg} />
                        <span className="more-sheet-label">{t(labelKey)}</span>
                        {current ? <CheckIcon size={ICON.sm} className="more-sheet-check" /> : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <ul className="more-sheet-group">
              <li>
                <button type="button" className="more-sheet-row" onClick={() => runThenClose(onSearch)}>
                  <ActionSearch size={ICON.lg} />
                  <span className="more-sheet-label">{t("nav.search")}</span>
                </button>
              </li>
              {onboarding && onOpenOnboarding ? (
                <li>
                  <button type="button" className="more-sheet-row" onClick={() => runThenClose(onOpenOnboarding)}>
                    <span className="more-sheet-count tnum" aria-hidden="true">{onboarding.done}/{onboarding.total}</span>
                    <span className="more-sheet-label">{t("onboarding.chip", onboarding)}</span>
                  </button>
                </li>
              ) : null}
            </ul>

            <ul className="more-sheet-group">
              <li>
                <button type="button" className="more-sheet-row more-sheet-row--danger" onClick={() => runThenClose(onLogout)}>
                  <NavLogout size={ICON.lg} />
                  <span className="more-sheet-label">{t("nav.logout")}</span>
                </button>
              </li>
            </ul>
          </DialogContent>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
