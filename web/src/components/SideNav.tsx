import { useCallback, useEffect, useRef, useState, type ComponentType, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ActionSearch,
  ICON,
  NavAdmin,
  NavAgents,
  NavBacklog,
  NavLogout,
  NavMore,
  NavPreferences,
  NavProjects,
  NavRoutine,
  NavSidebarCollapse,
  NavSidebarExpand,
  NavTeams,
  NavThreads,
  type GlyphProps,
} from "./icons";
import { RelayMark } from "./RelayMark";
import { commandShortcutLabel } from "../lib/shortcuts";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { MobileMoreSheet } from "./MobileMoreSheet";
import type { AppRoute } from "../lib/viewTypes";
import {
  clampSidenavWidth, maxSidenavWidth, SIDENAV_WIDTH_DEFAULT, SIDENAV_WIDTH_MAX, SIDENAV_WIDTH_MIN,
} from "../lib/sidenav";
import { chatColumnWidth, viewportWidth } from "../lib/shellMetrics";
import { NotificationBell, type NotificationBellBinding } from "./notifications/NotificationBell";

/** Mobile-only More overflow: the destinations that do not fit the bottom tab
 *  bar. A table rather than five repeated <a> blocks — the blocks differed
 *  only in icon, label, and route, and the admin one only in being gated. */
const MORE_ROUTES: readonly {
  route: AppRoute;
  /* icons.tsx exports stroked wrappers, filled identity glyphs, and the odd
     bespoke one, which have different component types; GlyphProps is the call
     shape they share, which is all a table of icons needs. */
  Icon: ComponentType<GlyphProps>;
  labelKey: string;
  adminOnly?: boolean;
}[] = [
  { route: "routine", Icon: NavRoutine, labelKey: "nav.routine" },
  { route: "teams", Icon: NavTeams, labelKey: "nav.teams" },
  { route: "settings", Icon: NavPreferences, labelKey: "nav.settings" },
  { route: "admin", Icon: NavAdmin, labelKey: "nav.admin", adminOnly: true },
];

// Left rail: brand, collapse toggle, route nav, settings/logout. Owns its own
// collapsed-state hover tooltip (only shown while the rail is collapsed).
export function SideNav({ sidenavExpanded, setSidenavExpanded, width, onResize, onResizeActive, route, onNavigateRoute, hrefForRoute, isAdmin, onLogout, onOpenCommandMenu, onboarding = null, onOpenOnboarding, notifications }: {
  sidenavExpanded: boolean;
  setSidenavExpanded: (expanded: boolean) => void;
  width: number;
  onResize: (width: number, commit: boolean) => void;
  onResizeActive: (active: boolean) => void;
  route: AppRoute;
  onNavigateRoute: (route: AppRoute) => void;
  hrefForRoute: (route: AppRoute) => string;
  isAdmin: boolean;
  onLogout: () => void;
  onOpenCommandMenu: () => void;
  /** Setup progress while the onboarding wizard is active; null hides the chip. */
  onboarding?: { done: number; total: number } | null;
  onOpenOnboarding?: () => void;
  notifications?: NotificationBellBinding;
}) {
  const { t } = useTranslation();
  const [navTooltip, setNavTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tooltipSuppressRef = useRef<HTMLElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!navTooltip) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      tooltipSuppressRef.current = document.activeElement as HTMLElement | null;
      setNavTooltip(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [navTooltip]);

  /* `always` is for the footer's chrome controls: they are icon squares in
     BOTH rail states, so their hint cannot be gated on the rail being
     collapsed the way a labelled nav row's is. */
  function showNavTooltip(text: string, el: HTMLElement, always = false) {
    if (sidenavExpanded && !always) return;
    if (tooltipSuppressRef.current === el) return;
    const rect = el.getBoundingClientRect();
    setNavTooltip({ text, x: rect.right + 12, y: rect.top + rect.height / 2 });
  }
  function hideNavTooltip() {
    tooltipSuppressRef.current = null;
    setNavTooltip(null);
  }
  function onMoreOpenChange(open: boolean) {
    if (open) hideNavTooltip();
    setMoreOpen(open);
  }
  function handleRouteClick(event: MouseEvent<HTMLAnchorElement>, nextRoute: AppRoute) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigateRoute(nextRoute);
  }

  /* Ceiling measured against the live chat column — read once per gesture and
     once per key press, never per pointer move. */
  const sidenavCeiling = useCallback(() => maxSidenavWidth(width, chatColumnWidth(), viewportWidth()), [width]);

  const moreActive = ["routine", "teams", "settings", "admin"].includes(route);
  const commandMenuHint = `${t("command.title")} · ${commandShortcutLabel()}`;

  return (
    <aside className="sidenav-panel" aria-label={t("nav.brand")} data-expanded={sidenavExpanded ? "true" : "false"}>
      {/* Brand only. The collapse toggle used to share this row and had to
          drop onto a second line when the rail narrowed to 72px (a 36px mark
          and a 32px control do not fit), so the button jumped ~70px out from
          under the cursor that had just clicked it. It now lives in the
          footer with the other rail-level control, at a stable position in
          both states. */}
      <div className="sidenav-brand-row">
        <div className="sidenav-brand" aria-hidden="true">
          <span className="sidenav-brand-mark"><RelayMark size={ICON.xl} tone="brand" /></span>
          <span className="sidenav-brand-copy">
            <span className="sidenav-brand-word sr-only">Relay</span>
          </span>
        </div>
      </div>
      <nav className="sidenav-nav" aria-label={t("nav.workspace_label")}>
        <div className="sidenav-group" role="group">
          <a
            className={`sidenav-btn ${route === "main" ? "active" : ""}`}
            data-nav="threads"
            href={hrefForRoute("main")}
            aria-label={t("nav.threads")}
            aria-current={route === "main" ? "page" : undefined}
            onClick={(event) => handleRouteClick(event, "main")}
            onMouseEnter={(e) => showNavTooltip(t("nav.threads"), e.currentTarget)}
            onMouseLeave={hideNavTooltip}
            onFocus={(e) => showNavTooltip(t("nav.threads"), e.currentTarget)}
            onBlur={hideNavTooltip}
          >
            <NavThreads size={ICON.lg} />
            <span className="sidenav-label sr-only">{t("nav.threads")}</span>
          </a>
          <a
            className={`sidenav-btn sidenav-secondary-item ${route === "routine" ? "active" : ""}`}
            data-nav="routine"
            href={hrefForRoute("routine")}
            aria-label={t("nav.routine")}
            aria-current={route === "routine" ? "page" : undefined}
            onClick={(event) => handleRouteClick(event, "routine")}
            onMouseEnter={(e) => showNavTooltip(t("nav.routine"), e.currentTarget)}
            onMouseLeave={hideNavTooltip}
            onFocus={(e) => showNavTooltip(t("nav.routine"), e.currentTarget)}
            onBlur={hideNavTooltip}
          >
            <NavRoutine size={ICON.lg} />
            <span className="sidenav-label sr-only">{t("nav.routine")}</span>
          </a>
        </div>
        <div className="sidenav-group sidenav-group--separated" role="group" aria-label={t("nav.workspace")}>
          <span className="sidenav-group-label sr-only" aria-hidden="true">{t("nav.workspace")}</span>
          <a
            className={`sidenav-btn ${route === "projects" ? "active" : ""}`}
            data-nav="projects"
            href={hrefForRoute("projects")}
            aria-label={t("project.projects")}
            aria-current={route === "projects" ? "page" : undefined}
            onClick={(event) => handleRouteClick(event, "projects")}
            onMouseEnter={(e) => showNavTooltip(t("project.projects"), e.currentTarget)}
            onMouseLeave={hideNavTooltip}
            onFocus={(e) => showNavTooltip(t("project.projects"), e.currentTarget)}
            onBlur={hideNavTooltip}
          >
            <NavProjects size={ICON.lg} />
            <span className="sidenav-label sr-only">{t("project.projects")}</span>
          </a>
          <a
            className={`sidenav-btn ${route === "backlog" ? "active" : ""}`}
            data-nav="backlog"
            href={hrefForRoute("backlog")}
            aria-label={t("nav.backlog")}
            aria-current={route === "backlog" ? "page" : undefined}
            onClick={(event) => handleRouteClick(event, "backlog")}
            onMouseEnter={(e) => showNavTooltip(t("nav.backlog"), e.currentTarget)}
            onMouseLeave={hideNavTooltip}
            onFocus={(e) => showNavTooltip(t("nav.backlog"), e.currentTarget)}
            onBlur={hideNavTooltip}
          >
            <NavBacklog size={ICON.lg} />
            <span className="sidenav-label sr-only">{t("nav.backlog")}</span>
          </a>
        </div>
        <div className="sidenav-group sidenav-group--separated" role="group" aria-label={t("nav.workforce")}>
          <span className="sidenav-group-label sr-only" aria-hidden="true">{t("nav.workforce")}</span>
          <a
            className={`sidenav-btn ${route === "agents" ? "active" : ""}`}
            data-nav="agents"
            href={hrefForRoute("agents")}
            aria-label={t("nav.agents")}
            aria-current={route === "agents" ? "page" : undefined}
            onClick={(event) => handleRouteClick(event, "agents")}
            onMouseEnter={(e) => showNavTooltip(t("nav.agents"), e.currentTarget)}
            onMouseLeave={hideNavTooltip}
            onFocus={(e) => showNavTooltip(t("nav.agents"), e.currentTarget)}
            onBlur={hideNavTooltip}
          >
            <NavAgents size={ICON.lg} />
            <span className="sidenav-label sr-only">{t("nav.agents")}</span>
          </a>
          <a
            className={`sidenav-btn sidenav-secondary-item ${route === "teams" ? "active" : ""}`}
            data-nav="teams"
            href={hrefForRoute("teams")}
            aria-label={t("nav.teams")}
            aria-current={route === "teams" ? "page" : undefined}
            onClick={(event) => handleRouteClick(event, "teams")}
            onMouseEnter={(event) => showNavTooltip(t("nav.teams"), event.currentTarget)}
            onMouseLeave={hideNavTooltip}
            onFocus={(event) => showNavTooltip(t("nav.teams"), event.currentTarget)}
            onBlur={hideNavTooltip}
          >
            <NavTeams size={ICON.lg} />
            <span className="sidenav-label sr-only">{t("nav.teams")}</span>
          </a>
        </div>
        {isAdmin ? (
          <div className="sidenav-group sidenav-group--separated" role="group" aria-label={t("nav.manage")}>
            <span className="sidenav-group-label sidenav-overflow-item sr-only" aria-hidden="true">{t("nav.manage")}</span>
            <a
              className={`sidenav-btn sidenav-secondary-item sidenav-overflow-item ${route === "admin" ? "active" : ""}`}
              data-nav="admin"
              href={hrefForRoute("admin")}
              aria-label={t("nav.admin")}
              aria-current={route === "admin" ? "page" : undefined}
              onClick={(event) => handleRouteClick(event, "admin")}
              onMouseEnter={(e) => showNavTooltip(t("nav.admin"), e.currentTarget)}
              onMouseLeave={hideNavTooltip}
              onFocus={(e) => showNavTooltip(t("nav.admin"), e.currentTarget)}
              onBlur={hideNavTooltip}
            >
              <NavAdmin size={ICON.lg} />
              <span className="sidenav-label sr-only">{t("nav.admin")}</span>
            </a>
          </div>
        ) : null}
        {/* Mobile-only: the destinations that do not fit the bottom tab bar. */}
        <div className="sidenav-group sidenav-group--separated" role="group" aria-label={t("nav.more_label")}>
          {/* Opens the More sheet (MobileMoreSheet), rendered below. */}
          <Button
            type="button"
            variant="ghost"
            className={`sidenav-btn sidenav-more-btn ${moreActive || moreOpen ? "active" : ""}`}
            data-nav="more"
            aria-label={t("nav.more_label")}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => onMoreOpenChange(true)}
          >
            <NavMore size={ICON.lg} />
            <span className="sidenav-label sr-only">{t("nav.more")}</span>
          </Button>
        </div>
      </nav>
      <div className="sidenav-bottom">
        {/* Setup is still underway: one square back to the wizard, wherever
            the person has wandered. Hidden once the wizard is dismissed. */}
        {onboarding && onOpenOnboarding ? (
          <Button
            type="button"
            variant="ghost"
            className="sidenav-btn sidenav-onboarding"
            data-nav="onboarding"
            tooltip={t("onboarding.chip", onboarding)}
            onClick={() => {
              hideNavTooltip();
              onOpenOnboarding();
            }}
          >
            <span className="sidenav-onboarding-count" aria-hidden="true">{onboarding.done}/{onboarding.total}</span>
            <span className="sr-only">{t("onboarding.chip", onboarding)}</span>
          </Button>
        ) : null}
        {/* The palette's visible trigger lives with the other rail-level
            controls, not the destination list: it opens a command surface,
            it does not navigate anywhere. */}
        <Button
          type="button"
          variant="ghost"
          className="sidenav-btn"
          data-nav="command"
          tooltip={commandMenuHint}
          onClick={() => {
            hideNavTooltip();
            onOpenCommandMenu();
          }}
        >
          <ActionSearch size={ICON.md} />
          <span className="sr-only">{t("command.title")}</span>
        </Button>
        {/* The inbox opens a panel beside the rail rather than navigating,
            so it sits with the chrome squares, next to the palette. */}
        {notifications ? (
          <NotificationBell
            {...notifications}
            className="sidenav-btn"
            side="right"
            align="end"
            triggerProps={{
              onMouseEnter: (e) => showNavTooltip(t("notifications.title"), e.currentTarget, true),
              onMouseLeave: hideNavTooltip,
              onFocus: (e) => showNavTooltip(t("notifications.title"), e.currentTarget, true),
              onBlur: hideNavTooltip,
            }}
          />
        ) : null}
        {/* Settings is a direct footer link; sign-out used to hide inside its
            menu, which made the gear an account surface instead of a
            destination. Two controls, one job each. */}
        <a
          className={`sidenav-btn ${route === "settings" ? "active" : ""}`}
          data-nav="settings"
          href={hrefForRoute("settings")}
          aria-label={t("nav.settings")}
          aria-current={route === "settings" ? "page" : undefined}
          onClick={(event) => handleRouteClick(event, "settings")}
          onMouseEnter={(e) => showNavTooltip(t("nav.settings"), e.currentTarget, true)}
          onMouseLeave={hideNavTooltip}
          onFocus={(e) => showNavTooltip(t("nav.settings"), e.currentTarget, true)}
          onBlur={hideNavTooltip}
        >
          <NavPreferences size={ICON.md} />
          <span className="sr-only">{t("nav.settings")}</span>
        </a>
        <Button
          type="button"
          variant="ghost"
          className="sidenav-btn"
          data-nav="logout"
          tooltip={t("nav.logout")}
          onClick={onLogout}
        >
          <NavLogout size={ICON.md} />
          <span className="sr-only">{t("nav.logout")}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          tooltip={sidenavExpanded ? t("nav.collapse_sidebar") : t("nav.expand_sidebar")}
          className="sidenav-btn sidenav-toggle"
          data-nav="collapse"
          onClick={() => setSidenavExpanded(!sidenavExpanded)}
        >
          {sidenavExpanded ? <NavSidebarCollapse size={ICON.md} /> : <NavSidebarExpand size={ICON.md} />}
          <span className="sr-only">{sidenavExpanded ? t("nav.collapse") : t("nav.expand")}</span>
        </Button>
      </div>
      <MobileMoreSheet
        open={moreOpen}
        onOpenChange={onMoreOpenChange}
        routes={MORE_ROUTES.filter(({ adminOnly }) => !adminOnly || isAdmin)}
        currentRoute={route}
        hrefForRoute={hrefForRoute}
        onNavigate={handleRouteClick}
        onSearch={onOpenCommandMenu}
        onboarding={onboarding}
        onOpenOnboarding={onOpenOnboarding}
        onLogout={onLogout}
      />
      {navTooltip ? createPortal(
        <div
          className="sidenav-tooltip"
          role="tooltip"
          style={{ top: navTooltip.y, left: navTooltip.x }}
        >
          {navTooltip.text}
        </div>,
        document.body,
      ) : null}
      {/* Only the expanded rail is resizable — the collapsed rail is a fixed
          icon column with nothing for a drag to reveal. Hidden at <=820px
          with the other separators (responsive.css), where the shell is
          single-column. */}
      {sidenavExpanded ? (
        <ResizeHandle
          className="sidenav-resize"
          label={t("nav.resize_label")}
          width={width}
          min={SIDENAV_WIDTH_MIN}
          max={SIDENAV_WIDTH_MAX}
          defaultWidth={SIDENAV_WIDTH_DEFAULT}
          /* The rail is the leftmost track, so dragging right grows it. */
          grows="inline-end"
          clamp={clampSidenavWidth}
          ceiling={sidenavCeiling}
          onResize={onResize}
          onResizeActive={onResizeActive}
        />
      ) : null}
    </aside>
  );
}
