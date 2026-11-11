"use client";

import type { CSSProperties, ReactNode } from "react";
import { memo, useCallback, useMemo, useState } from "react";
import { MobileTopbarSlotContext } from "./MobileTopbarSlot";
import { useTranslation } from "react-i18next";
import {
  ICON,
  NavBack,
} from "./icons";
import type { Theme } from "@/lib/appStorage";
import { SideNav as SideNavView } from "./SideNav";
import { ArtifactNavButton } from "./ArtifactNavButton";
import { CommandMenu as CommandMenuView } from "./CommandMenu";
import { ShortcutsHelp as ShortcutsHelpView } from "./ShortcutsHelp";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { buildCommands, type CommandId } from "@/lib/commandMenu";
import { mobileTopbarMode } from "@/lib/mobileTopbar";
import { taskCreateIntent } from "@/lib/taskCreateIntent";
import type { ShortcutAction } from "@/lib/shortcuts";
import type { AppRoute, MobileView } from "@/lib/viewTypes";
import type { CurrentUser } from "@/types";
import { Button } from "@/components/ui/button";
import { NotificationBell, type NotificationBellBinding } from "./notifications/NotificationBell";

type MobileChatChrome = {
  artifactCount: number;
  /** Whether the open thread sits in a project — the panel leads with the
   *  project workspace when it does, and the toggle is named for that. */
  inProject: boolean;
  spaceOpen: boolean;
  spaceDisabled: boolean;
  onToggleSpace: () => void;
};

type AppShellProps = {
  taskWorkspace?: boolean;
  taskThread?: boolean;
  threadOpen?: boolean;
  /** The path named no page; the shell must not dress it as a thread. */
  notFound?: boolean;
  onNewTask?: () => void;
  route: AppRoute;
  onNavigateRoute: (route: AppRoute) => void;
  hrefForRoute: (route: AppRoute) => string;
  mobileView: MobileView;
  onMobileViewChange: (view: MobileView) => void;
  sidenavExpanded: boolean;
  setSidenavExpanded: (expanded: boolean) => void;
  sidenavWidth: number;
  sidenavResizing: boolean;
  onSidenavResize: (width: number, commit: boolean) => void;
  onSidenavResizeActive: (active: boolean) => void;
  skipLinkHref: string;
  activeThreadLabel: string;
  threadSpaceOpen: boolean;
  threadSpaceWidth: number;
  threadSpaceResizing: boolean;
  threadListHidden: boolean;
  threadListWidth: number;
  threadListResizing: boolean;
  mobileChatChrome: MobileChatChrome | null;
  user: CurrentUser;
  onLogout: () => void;
  /** Starts a fresh thread in the composer (the `n` chord / palette command). */
  onNewThread: () => void;
  /** Setup progress for the rail's "Get started" chip; null hides it. */
  onboarding: { done: number; total: number } | null;
  /** Opens the onboarding wizard, reopening it if it was dismissed. */
  onOpenOnboarding: () => void;
  notifications: NotificationBellBinding;
  /** Home's "needs you" count, badged on its rail entry. */
  homeNeedsYou?: number;
  children: ReactNode;
  /** The theme lives here for the `toggle-theme` command only; the settings
   *  route owns the full appearance and language controls. */
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
};

// The shell re-renders on every streamed frame of the open run (its title and
// chrome read the active thread). These leaves read none of that, so they are
// memoized here and every handler they receive keeps its identity.
const SideNav = memo(SideNavView);
const CommandMenu = memo(CommandMenuView);
const ShortcutsHelp = memo(ShortcutsHelpView);

export function AppShell({
  taskWorkspace = false,
  taskThread = false,
  threadOpen = false,
  notFound = false,
  onNewTask,
  route,
  onNavigateRoute,
  hrefForRoute,
  mobileView,
  onMobileViewChange,
  sidenavExpanded,
  setSidenavExpanded,
  sidenavWidth,
  sidenavResizing,
  onSidenavResize,
  onSidenavResizeActive,
  skipLinkHref,
  activeThreadLabel,
  threadSpaceOpen,
  threadSpaceWidth,
  threadSpaceResizing,
  threadListHidden,
  threadListWidth,
  threadListResizing,
  mobileChatChrome,
  user,
  onLogout,
  onNewThread,
  onboarding,
  onOpenOnboarding,
  notifications,
  homeNeedsYou = 0,
  children,
  theme,
  onThemeChange,
}: AppShellProps) {
  const { t } = useTranslation();
  const isAdmin = user.role === "admin";
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const queueNewTask = useCallback(() => {
    if (onNewTask) { onNewTask(); return; }
    // Queue before navigating: the event notifies a mounted backlog directly,
    // and the one-shot flag survives the route change for a mounting one.
    taskCreateIntent()?.queue();
    if (!taskWorkspace) onNavigateRoute("backlog");
  }, [onNavigateRoute, onNewTask, taskWorkspace]);

  const runCommand = useCallback((id: CommandId) => {
    if (id.startsWith("go:")) {
      onNavigateRoute(id.slice(3) as AppRoute);
      return;
    }
    switch (id) {
      case "new-thread":
        onNewThread();
        break;
      case "new-task":
        queueNewTask();
        break;
      case "toggle-sidebar":
        setSidenavExpanded(!sidenavExpanded);
        break;
      case "toggle-theme":
        onThemeChange(theme === "light" ? "dark" : "light");
        break;
      case "open-preferences":
        onNavigateRoute("settings");
        break;
      case "shortcuts-help":
        setShortcutsOpen(true);
        break;
      case "get-started":
        onOpenOnboarding();
        break;
    }
  }, [onNavigateRoute, onNewThread, onOpenOnboarding, onThemeChange, queueNewTask, setSidenavExpanded, sidenavExpanded, theme]);

  const handleShortcut = useCallback((action: ShortcutAction) => {
    switch (action.kind) {
      case "command-menu":
        setCommandOpen((open) => !open);
        break;
      case "shortcuts-help":
        setShortcutsOpen(true);
        break;
      case "go":
        onNavigateRoute(action.route);
        break;
      case "new-thread":
        onNewThread();
        break;
      case "new-task":
        queueNewTask();
        break;
    }
  }, [onNavigateRoute, onNewThread, queueNewTask]);

  const openCommandMenu = useCallback(() => setCommandOpen(true), []);
  const closeCommandMenu = useCallback(() => setCommandOpen(false), []);
  const closeShortcutsHelp = useCallback(() => setShortcutsOpen(false), []);

  useGlobalShortcuts({
    isAdmin,
    overlayOpen: commandOpen || shortcutsOpen,
    onAction: handleShortcut,
  });

  const commands = useMemo(
    () => buildCommands({ isAdmin, t }),
    [isAdmin, t],
  );

  const surfaceRoute = threadOpen && !notFound ? "main" : route;
  const topbar = mobileTopbarMode({ route: surfaceRoute, notFound, taskThread: taskThread && !threadOpen, taskWorkspace, mobileView });
  const isMobileChat = topbar.chat;
  const directoryLabel = t(topbar.directoryKey);
  const mobileTitle = topbar.titleKey === null ? activeThreadLabel : t(topbar.titleKey);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const [leadSlot, setLeadSlot] = useState<HTMLDivElement | null>(null);
  const [titleSlot, setTitleSlot] = useState<HTMLDivElement | null>(null);
  const topbarSlots = useMemo(
    () => ({ actions: actionsSlot, lead: leadSlot, title: titleSlot }),
    [actionsSlot, leadSlot, titleSlot],
  );

  return (
    <MobileTopbarSlotContext.Provider value={topbarSlots}>
    <div
      className="messenger-shell"
      data-mobile-view={mobileView}
      data-mobile-chat={isMobileChat || undefined}
      data-route={surfaceRoute}
      data-task-thread={taskThread || undefined}
      data-task-workspace={taskWorkspace || undefined}
      data-sidenav={sidenavExpanded ? "open" : "closed"}
      data-space={threadSpaceOpen ? "open" : undefined}
      data-sidenav-resizing={sidenavResizing || undefined}
      data-space-resizing={threadSpaceResizing || undefined}
      data-threadlist={threadSpaceOpen && !threadListHidden ? "open" : undefined}
      data-threadlist-resizing={threadListResizing || undefined}
      style={{
        "--sidenav-w-open": `${sidenavWidth}px`,
        "--space-w": `${threadSpaceWidth}px`,
        "--thread-w": `${threadListWidth}px`,
      } as CSSProperties}
    >
      <a className="skip-link" href={skipLinkHref}>{t("skip_to_content")}</a>

      {/* The phone top bar: one shape on every route — a back control when
          the screen is nested, a single title line, then the screen's own
          actions (portaled into the slot by MobileTopbarActions). Settings is
          not here: it lives in the tab bar's More menu with the other
          secondary destinations, so the bar carries only what the screen
          itself does. It used to be three shapes: a centred two-line
          "Relay / Issues" label, a full-width pill naming the thread
          directory, and a chat-bubble glyph standing in for "back". */}
      <div className="mobile-topbar">
        {/* The leading slot: the thread's back control, or a nested route
            screen's, portaled in by MobileTopbarBack. Empty, it takes no
            width. */}
        <div className="mobile-topbar-lead" ref={setLeadSlot}>
          {isMobileChat ? (
            <Button
              variant="ghost"
              type="button"
              className="mobile-topbar-back"
              aria-label={directoryLabel}
              onClick={() => onMobileViewChange("threads")}
            >
              <NavBack size={ICON.md} />
            </Button>
          ) : null}
        </div>
        <div className="mobile-topbar-heading" title={mobileTitle}>
          <span className="mobile-topbar-title">{mobileTitle}</span>
          {/* A record screen's own name, portaled in by
              useMobileTopbarTitle; filled, it replaces the route title. */}
          <div className="mobile-topbar-title-slot" ref={setTitleSlot} />
        </div>
        <div className="mobile-topbar-tools">
          {/* A new thread has no files yet; a disabled toggle would only take
              one of the bar's few glyph slots. */}
          {isMobileChat && mobileChatChrome && !mobileChatChrome.spaceDisabled ? (
            <ArtifactNavButton
              artifactCount={mobileChatChrome.artifactCount}
              inProject={mobileChatChrome.inProject}
              onOpenArtifacts={mobileChatChrome.onToggleSpace}
              expanded={mobileChatChrome.spaceOpen}
              disabled={mobileChatChrome.spaceDisabled}
            />
          ) : null}
          <div className="mobile-topbar-actions" ref={setActionsSlot} />
          {/* The rail's footer, where the desktop bell lives, is hidden on
              phones; the inbox rides at the end of the top bar instead, on
              every route, after the screen's own actions. */}
          <NotificationBell {...notifications} className="mobile-topbar-bell" variant="icon" side="bottom" align="end" />
        </div>
      </div>

      <SideNav
        sidenavExpanded={sidenavExpanded}
        setSidenavExpanded={setSidenavExpanded}
        width={sidenavWidth}
        onResize={onSidenavResize}
        onResizeActive={onSidenavResizeActive}
        route={notFound ? null : route}
        threadOpen={threadOpen}
        onNavigateRoute={onNavigateRoute}
        hrefForRoute={hrefForRoute}
        isAdmin={isAdmin}
        onLogout={onLogout}
        onOpenCommandMenu={openCommandMenu}
        onboarding={onboarding}
        onOpenOnboarding={onOpenOnboarding}
        notifications={notifications}
        homeNeedsYou={homeNeedsYou}
      />

      {/* display:contents (owned by shell.css, .messenger-shell > main) keeps
          the route panels as direct grid items of .messenger-shell while the
          <main> landmark stays a sibling of the SideNav <nav>. */}
      <main>
        {children}
      </main>

      <CommandMenu
        open={commandOpen}
        commands={commands}
        onRun={runCommand}
        onClose={closeCommandMenu}
      />
      <ShortcutsHelp
        open={shortcutsOpen}
        isAdmin={isAdmin}
        onClose={closeShortcutsHelp}
      />
    </div>
    </MobileTopbarSlotContext.Provider>
  );
}

export function RouteFallback() {
  const { t } = useTranslation();
  return (
    <div className="route-loading" role="status" aria-live="polite">
      {t("admin.loading")}
    </div>
  );
}
