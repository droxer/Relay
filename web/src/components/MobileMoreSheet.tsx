"use client";

import { type ComponentType, type CSSProperties, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from "@/components/ui/dialog";
import { useSheetDrag } from "../hooks/useSheetDrag";
import { ActionSearch, CheckIcon, ICON, NavLogout, type GlyphProps } from "./icons";
import type { AppRoute } from "../lib/viewTypes";

export type MoreSheetRoute = {
  route: AppRoute;
  Icon: ComponentType<GlyphProps>;
  labelKey: string;
};

/** One titled section of the sheet: the same sections the desktop rail draws. */
export type MoreSheetGroup = {
  labelKey: string;
  routes: readonly MoreSheetRoute[];
};

/** The phone tab bar's More destination, as a bottom sheet rather than a
 *  popover: the pattern a thumb expects from the bar it was opened from, and
 *  the one Linear's mobile app uses. Top to bottom it reads as one job per
 *  band: find (Search, plus setup while it is underway), go (the rail's
 *  sections, each titled, in the rail's order), leave (Sign out, alone, so a
 *  destructive row never sits among destinations). Every row is a full-width
 *  48px target. The Dialog primitive supplies the scrim, the focus trap,
 *  Escape, and focus restore to the More tab. */
export function MobileMoreSheet({
  open,
  onOpenChange,
  groups,
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
  groups: readonly MoreSheetGroup[];
  currentRoute: AppRoute | null;
  hrefForRoute: (route: AppRoute) => string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, route: AppRoute) => void;
  onSearch: () => void;
  onboarding: { done: number; total: number } | null;
  onOpenOnboarding?: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  function close() {
    onOpenChange(false);
  }

  const { offset: dragY, handlers: grabHandlers, reset: resetDrag } = useSheetDrag(close);

  /* Each action closes the sheet first, so focus restore lands on the More
     tab before the next surface (the palette, the wizard) takes it. */
  function runThenClose(action: () => void) {
    close();
    action();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(next) => { if (!next) resetDrag(); }}>
      <DialogPortal>
        <DialogBackdrop className="more-sheet-backdrop" />
        <DialogViewport className="more-sheet-viewport">
          <DialogContent
            className="more-sheet"
            data-dragging={dragY > 0 || undefined}
            style={dragY > 0 ? ({ transform: `translateY(${dragY}px)`, "--sheet-drag": `${dragY}px` } as CSSProperties) : undefined}
          >
            <div
              className="more-sheet-grab"
              aria-hidden="true"
              {...grabHandlers}
            >
              <span className="more-sheet-grabber" />
            </div>
            <DialogTitle className="more-sheet-title">{t("nav.more")}</DialogTitle>

            {/* Search opens the command palette, which reaches every page and
                action. Drawn as the field it leads to, not as one more row. */}
            <button type="button" className="more-sheet-search" onClick={() => runThenClose(onSearch)}>
              <ActionSearch size={ICON.md} />
              <span>{t("nav.search")}</span>
            </button>

            {onboarding && onOpenOnboarding ? (
              <ul className="more-sheet-group">
                <li>
                  <button type="button" className="more-sheet-row" onClick={() => runThenClose(onOpenOnboarding)}>
                    {/* The count sits in the icon column, so the label is the
                        bare eyebrow — the chip copy would say it twice. */}
                    <span className="more-sheet-count tnum" aria-hidden="true">{onboarding.done}/{onboarding.total}</span>
                    <span className="more-sheet-label" aria-hidden="true">{t("onboarding.eyebrow")}</span>
                    <span className="sr-only">{t("onboarding.chip", onboarding)}</span>
                  </button>
                </li>
              </ul>
            ) : null}

            <nav className="more-sheet-nav" aria-label={t("nav.more_label")}>
              {groups.map(({ labelKey, routes }) => (
                <section key={labelKey} className="more-sheet-section" aria-labelledby={`more-sheet-${labelKey}`}>
                  <h3 id={`more-sheet-${labelKey}`} className="more-sheet-heading">{t(labelKey)}</h3>
                  <ul className="more-sheet-group">
                    {routes.map(({ route, Icon, labelKey: rowLabelKey }) => {
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
                            <span className="more-sheet-label">{t(rowLabelKey)}</span>
                            {current ? <CheckIcon size={ICON.sm} className="more-sheet-check" /> : null}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </nav>

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
