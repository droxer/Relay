import { useCallback, useEffect, useRef, useState, type Dispatch, type ComponentType, type MouseEvent, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ActionSearch,
  ICON,
  NavAdmin,
  NavAgents,
  NavBacklog,
  NavComputer,
  NavLogout,
  NavMore,
  NavPreferences,
  NavRoutine,
  NavSidebarCollapse,
  NavSidebarExpand,
  NavTeams,
  NavThreads,
  WorkspaceFolder,
} from "./icons";
import { BookOpen, type LucideProps } from "lucide-react";
import { RelayMark } from "./RelayMark";
import { commandShortcutLabel } from "../lib/shortcuts";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppRoute } from "../lib/viewTypes";
import {
  clampSidenavWidth, maxSidenavWidth, SIDENAV_WIDTH_DEFAULT, SIDENAV_WIDTH_MAX, SIDENAV_WIDTH_MIN,
} from "../lib/sidenav";

/** Mobile-only More overflow: the destinations that do not fit the bottom tab
 *  bar. A table rather than five repeated <a> blocks — the blocks differed
 *  only in icon, label, and route, and the admin one only in being gated. */
const MORE_ROUTES: readonly {
  route: AppRoute;
  /* `withStandardStroke` wrappers and bare lucide icons both appear in
     icons.tsx and have different component types; this is the call shape they
     share, which is all a table of icons needs. */
  Icon: ComponentType<Pick<LucideProps, "size" | "className">>;
  labelKey: string;
  adminOnly?: boolean;
}[] = [
  { route: "routine", Icon: NavRoutine, labelKey: "nav.routine" },
  { route: "teams", Icon: NavTeams, labelKey: "nav.teams" },
  { route: "skills", Icon: BookOpen, labelKey: "nav.skills" },
  { route: "computer", Icon: NavComputer, labelKey: "nav.computer" },
  { route: "admin", Icon: NavAdmin, labelKey: "nav.admin", adminOnly: true },
];

/** The chat column, measured to work out how much width the rail may still
 *  take. Read straight from the DOM rather than threaded down as a prop: the
 *  grid — not React — owns the column's real width. */
function chatWidth(): number | null {
  if (typeof document === "undefined") return null;
  const chat = document.getElementById("chat-panel");
  return chat ? chat.getBoundingClientRect().width : null;
}

// Left rail: brand, collapse toggle, route nav, settings/logout. Owns its own
// collapsed-state hover tooltip (only shown while the rail is collapsed).
export function SideNav({ sidenavExpanded, setSidenavExpanded, width, onResize, onResizeActive, route, onNavigateRoute, hrefForRoute, isAdmin, prefsOpen, setPrefsOpen, onLogout, onOpenCommandMenu }: {
  sidenavExpanded: boolean;
  setSidenavExpanded: (expanded: boolean) => void;
  width: number;
  onResize: (width: number, commit: boolean) => void;
  onResizeActive: (active: boolean) => void;
  route: AppRoute;
  onNavigateRoute: (route: AppRoute) => void;
  hrefForRoute: (route: AppRoute) => string;
  isAdmin: boolean;
  prefsOpen: boolean;
  setPrefsOpen: Dispatch<SetStateAction<boolean>>;
  onLogout: () => void;
  onOpenCommandMenu: () => void;
}) {
  const { t } = useTranslation();
  const [navTooltip, setNavTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tooltipSuppressRef = useRef<HTMLElement | null>(null);
  /* Open/closed only. The menus used to carry viewport coordinates because
     they were positioned by hand; the Menu positioner anchors to the trigger
     and handles flipping, so there is nothing left to store. */
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  /* The expanded rail anchors the settings menu to the FOOTER rather than to
     its trigger — see the menu's own note below. */
  const footerRef = useRef<HTMLDivElement>(null);
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
  /* Only one rail menu at a time. Two Menu roots do not know about each other,
     so the mutual close stays here — it is the one piece of this behaviour
     that was ever app-specific. */
  function onPreferencesOpenChange(open: boolean) {
    if (open) {
      hideNavTooltip();
      setMoreOpen(false);
    }
    setPreferencesOpen(open);
  }
  function onMoreOpenChange(open: boolean) {
    if (open) {
      hideNavTooltip();
      setPreferencesOpen(false);
    }
    setMoreOpen(open);
  }
  function openPreferences() {
    setPrefsOpen(true);
  }
  function handleLogout() {
    onLogout();
  }
  function handleRouteClick(event: MouseEvent<HTMLAnchorElement>, nextRoute: AppRoute) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigateRoute(nextRoute);
  }

  /* Ceiling measured against the live chat column — read once per gesture and
     once per key press, never per pointer move. */
  const sidenavCeiling = useCallback(() => maxSidenavWidth(width, chatWidth()), [width]);

  const moreActive = ["routine", "teams", "skills", "computer", "admin"].includes(route);
  const commandMenuHint = `${t("command.title")} · ${commandShortcutLabel()}`;

  return (
    <aside className="sidenav-panel" aria-label={t("nav.brand", { defaultValue: "Relay" })} data-expanded={sidenavExpanded ? "true" : "false"}>
      {/* Brand only. The collapse toggle used to share this row and had to
          drop onto a second line when the rail narrowed to 72px (a 36px mark
          and a 32px control do not fit), so the button jumped ~70px out from
          under the cursor that had just clicked it. It now lives in the
          footer with the other rail-level control, at a stable position in
          both states. */}
      <div className="sidenav-brand-row">
        <div className="sidenav-brand" aria-hidden="true">
          <span className="sidenav-brand-mark"><RelayMark size={ICON.xl} /></span>
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
            <WorkspaceFolder size={ICON.lg} />
            <span className="sidenav-label sr-only">{t("project.projects")}</span>
          </a>
        </div>
        <div className="sidenav-group sidenav-group--separated" role="group" aria-label={t("nav.workspace")}>
          <span className="sidenav-group-label sr-only" aria-hidden="true">{t("nav.workspace")}</span>
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
        <div className="sidenav-group sidenav-group--separated" role="group" aria-label={t("nav.manage")}>
          <span className="sidenav-group-label sidenav-overflow-item sr-only" aria-hidden="true">{t("nav.manage")}</span>
          <a
            className={`sidenav-btn sidenav-secondary-item sidenav-overflow-item ${route === "skills" ? "active" : ""}`}
            data-nav="skills"
            href={hrefForRoute("skills")}
            aria-label={t("nav.skills")}
            aria-current={route === "skills" ? "page" : undefined}
            onClick={(event) => handleRouteClick(event, "skills")}
            onMouseEnter={(e) => showNavTooltip(t("nav.skills"), e.currentTarget)}
            onMouseLeave={hideNavTooltip}
            onFocus={(e) => showNavTooltip(t("nav.skills"), e.currentTarget)}
            onBlur={hideNavTooltip}
          >
            <BookOpen size={ICON.lg} />
            <span className="sidenav-label sr-only">{t("nav.skills")}</span>
          </a>
          <a
            className={`sidenav-btn sidenav-secondary-item ${route === "computer" ? "active" : ""}`}
            data-nav="computer"
            href={hrefForRoute("computer")}
            aria-label={t("nav.computer")}
            aria-current={route === "computer" ? "page" : undefined}
            onClick={(event) => handleRouteClick(event, "computer")}
            onMouseEnter={(e) => showNavTooltip(t("nav.computer"), e.currentTarget)}
            onMouseLeave={hideNavTooltip}
            onFocus={(e) => showNavTooltip(t("nav.computer"), e.currentTarget)}
            onBlur={hideNavTooltip}
          >
            <NavComputer size={ICON.lg} aria-hidden="true" />
            <span className="sidenav-label sr-only">{t("nav.computer")}</span>
          </a>
          {isAdmin ? (
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
          ) : null}
          <DropdownMenu open={moreOpen} onOpenChange={onMoreOpenChange}>
            {/* aria-haspopup / aria-expanded come from the trigger now — the
                pair used to be written by hand on both rail menus. */}
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className={`sidenav-btn sidenav-more-btn ${moreActive || moreOpen ? "active" : ""}`}
                  data-nav="more"
                  aria-label={t("nav.more_label")}
                  onMouseEnter={(e) => showNavTooltip(t("nav.more"), e.currentTarget)}
                  onMouseLeave={hideNavTooltip}
                  onFocus={(e) => showNavTooltip(t("nav.more"), e.currentTarget)}
                  onBlur={hideNavTooltip}
                >
                  <NavMore size={ICON.lg} />
                  <span className="sidenav-label sr-only">{t("nav.more")}</span>
                </Button>
              }
            />
            {/* Rises above the mobile tab bar. The old hand-clamped x (More is
                the rightmost tab, so the menu had to be nudged off the right
                edge by hand) is the positioner's `shift` now. */}
            <DropdownMenuContent side="top" align="start" className="sidenav-more-menu">
              {MORE_ROUTES.filter(({ adminOnly }) => !adminOnly || isAdmin).map(({ route: target, Icon, labelKey }) => (
                <DropdownMenuLinkItem
                  key={target}
                  render={
                    <a
                      href={hrefForRoute(target)}
                      aria-current={route === target ? "page" : undefined}
                      onClick={(event: MouseEvent<HTMLAnchorElement>) => handleRouteClick(event, target)}
                    />
                  }
                >
                  <Icon size={ICON.md} />
                  <span>{t(labelKey)}</span>
                </DropdownMenuLinkItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>
      <div className="sidenav-bottom" ref={footerRef}>
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
        <DropdownMenu open={preferencesOpen} onOpenChange={onPreferencesOpenChange}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className={`sidenav-btn ${prefsOpen || preferencesOpen ? "active" : ""}`}
                data-nav="settings"
                type="button"
                aria-label={t("nav.preferences")}
                onMouseEnter={(e) => showNavTooltip(t("nav.preferences"), e.currentTarget, true)}
                onMouseLeave={hideNavTooltip}
                onFocus={(e) => showNavTooltip(t("nav.preferences"), e.currentTarget, true)}
                onBlur={hideNavTooltip}
              >
                <NavPreferences size={ICON.md} />
                <span className="sr-only">{t("nav.preferences")}</span>
              </Button>
            }
          />
          {/* Collapsed: fly out to the right of the icon, like the nav
              tooltips. Expanded: rise above the FOOTER — anchoring to the
              32px trigger instead opens the menu straddling the rail|content
              seam (the trigger sits mid-row, and the menu is wider than it),
              so the anchor is the row the trigger sits in. */}
          <DropdownMenuContent
            side={sidenavExpanded ? "top" : "right"}
            align={sidenavExpanded ? "start" : "end"}
            anchor={sidenavExpanded ? footerRef : undefined}
            className="sidenav-settings-menu"
          >
            <DropdownMenuItem onClick={openPreferences}>
              <NavPreferences size={ICON.md} />
              <span>{t("nav.preferences")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem danger onClick={handleLogout}>
              <NavLogout size={ICON.md} />
              <span>{t("nav.logout")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
