"use client";

import type { CSSProperties, ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { MobileTopbarSlotContext } from "./MobileTopbarSlot";
import { useTranslation } from "react-i18next";
import {
  ICON,
  NavPreferences,
  NavBack,
} from "./icons";
import type { Theme } from "@/lib/appStorage";
import { SideNav } from "./SideNav";
import { ArtifactNavButton } from "./ArtifactNavButton";
import { CommandMenu } from "./CommandMenu";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { buildCommands, type CommandId } from "@/lib/commandMenu";
import { taskCreateIntent } from "@/lib/taskCreateIntent";
import type { ShortcutAction } from "@/lib/shortcuts";
import type { AppRoute, MobileView } from "@/lib/viewTypes";
import type { CurrentUser } from "@/types";
import { Button } from "@/components/ui/button";

const WORK_ROUTE_LABEL_KEYS: Record<Exclude<AppRoute, "main" | "projects">, string> = {
  backlog: "nav.backlog",
  routine: "nav.routine",
  agents: "nav.agents",
  teams: "nav.teams",
  settings: "nav.settings",
  channels: "nav.channels",
  admin: "nav.admin",
};

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
  children: ReactNode;
  /** The theme lives here for the `toggle-theme` command only; the settings
   *  route owns the full appearance and language controls. */
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
};

/** The mobile topbar's settings affordance. Settings is a route now — the
 *  same one the rail's gear opens — so this navigates rather than toggling a
 *  modal. */
function SettingsButton({ route, href, onNavigate }: { route: AppRoute; href: string; onNavigate: () => void }) {
  const { t } = useTranslation();
  const active = route === "settings";
  return (
    <Button
      variant="ghost"
      render={<a href={href} />}
      nativeButton={false}
      className={`mobile-settings ${active ? "active" : ""}`}
      aria-label={t("nav.settings")}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onNavigate();
      }}
    >
      <NavPreferences size={ICON.md} />
    </Button>
  );
}

export function AppShell({
  taskWorkspace = false,
  taskThread = false,
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
    }
  }, [onNavigateRoute, onNewThread, onThemeChange, queueNewTask, setSidenavExpanded, sidenavExpanded, theme]);

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

  useGlobalShortcuts({
    isAdmin,
    overlayOpen: commandOpen || shortcutsOpen,
    onAction: handleShortcut,
  });

  const commands = useMemo(
    () => buildCommands({ isAdmin, t }),
    [isAdmin, t],
  );

  const isThreadRoute = taskThread || route === "main" || (route === "projects" && !taskWorkspace);
  const directoryLabel = taskThread ? t("thread.back_to_task") : route === "projects" ? t("project.projects") : t("nav.threads");
  const isMobileChat = isThreadRoute && mobileView === "chat";
  /* One title line on every route: the open thread in a conversation, the
     directory ("Threads", "Projects") over its list, and the route's own
     name everywhere else. Admin and settings name the SURFACE here — the
     section strip right under the bar already marks the section. */
  const mobileTitle = isMobileChat
    ? activeThreadLabel
    : isThreadRoute
      ? directoryLabel
      : taskWorkspace
        ? t("nav.backlog")
        : t(WORK_ROUTE_LABEL_KEYS[route as keyof typeof WORK_ROUTE_LABEL_KEYS]);
  const [topbarSlot, setTopbarSlot] = useState<HTMLDivElement | null>(null);

  return (
    <MobileTopbarSlotContext.Provider value={topbarSlot}>
    <div
      className="messenger-shell"
      data-mobile-view={mobileView}
      data-route={route}
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
          actions (portaled into the slot by MobileTopbarActions) and the
          settings gear. It used to be three shapes: a centred two-line
          "Relay / Issues" label, a full-width pill naming the thread
          directory, and a chat-bubble glyph standing in for "back". */}
      <div className="mobile-topbar" data-nested={isMobileChat || undefined}>
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
        <div className="mobile-topbar-heading" title={mobileTitle}>
          <span className="mobile-topbar-title">{mobileTitle}</span>
        </div>
        <div className="mobile-topbar-tools">
          {isMobileChat && mobileChatChrome ? (
            <ArtifactNavButton
              artifactCount={mobileChatChrome.artifactCount}
              inProject={mobileChatChrome.inProject}
              onOpenArtifacts={mobileChatChrome.onToggleSpace}
              expanded={mobileChatChrome.spaceOpen}
              disabled={mobileChatChrome.spaceDisabled}
            />
          ) : null}
          <div className="mobile-topbar-actions" ref={setTopbarSlot} />
          <SettingsButton route={route} href={hrefForRoute("settings")} onNavigate={() => onNavigateRoute("settings")} />
        </div>
      </div>

      <SideNav
        sidenavExpanded={sidenavExpanded}
        setSidenavExpanded={setSidenavExpanded}
        width={sidenavWidth}
        onResize={onSidenavResize}
        onResizeActive={onSidenavResizeActive}
        route={route}
        onNavigateRoute={onNavigateRoute}
        hrefForRoute={hrefForRoute}
        isAdmin={isAdmin}
        onLogout={onLogout}
        onOpenCommandMenu={() => setCommandOpen(true)}
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
        onClose={() => setCommandOpen(false)}
      />
      <ShortcutsHelp
        open={shortcutsOpen}
        isAdmin={isAdmin}
        onClose={() => setShortcutsOpen(false)}
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
