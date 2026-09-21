"use client";

import type { CSSProperties, ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ICON,
  NavPreferences,
  NavBack,
  NavThreads,
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
import type { AppRoute, MobileView, SettingsSection } from "@/lib/viewTypes";
import type { CurrentUser } from "@/types";
import { useRelayStore } from "@/lib/store";
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

/** The section a settings path is showing, for the mobile topbar's title. */
const SETTINGS_SECTION_LABEL_KEYS: Record<SettingsSection, string> = {
  computers: "computer.title",
  skills: "skills.title",
  appearance: "pref.appearance",
  language: "pref.language",
};

/** Routes that name themselves in the topbar's eyebrow rather than taking the
 *  generic product word — the two surfaces whose title line is a section. */
const MOBILE_EYEBROW_KEYS: Partial<Record<AppRoute, string>> = {
  admin: "nav.admin",
  settings: "nav.settings",
};

export type MobileChatChrome = {
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
  /** The open settings section, so the mobile topbar can name it the way it
   *  names the control panel's — both are rail-and-content surfaces. */
  settingsSection: SettingsSection;
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
  settingsSection,
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
  const adminView = useRelayStore((state) => state.adminView);
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
  /* A rail-and-content surface names its SECTION here — the strip under the
     topbar is the only other place the section appears, and the route name is
     already the eyebrow. Both consumers of the rail read the same way. */
  const mobileRouteTitle = taskWorkspace ? t("nav.backlog") : route === "admin"
    ? t(`admin.v2.title_${adminView}`)
    : route === "settings"
      ? t(SETTINGS_SECTION_LABEL_KEYS[settingsSection])
      : isThreadRoute
        ? directoryLabel
        : t(WORK_ROUTE_LABEL_KEYS[route as keyof typeof WORK_ROUTE_LABEL_KEYS]);
  const isMobileChat = isThreadRoute && mobileView === "chat";

  return (
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

      <div
        className={`mobile-topbar ${isThreadRoute ? "mobile-topbar--chat" : "mobile-topbar--route"}`}
      >
        {isThreadRoute ? (
          isMobileChat ? (
            <>
              <Button
                variant="ghost"
                type="button"
                className="mobile-topbar-back"
                aria-label={directoryLabel}
                onClick={() => onMobileViewChange("threads")}
              >
                {taskThread ? <NavBack size={ICON.md} /> : <NavThreads size={ICON.md} />}
              </Button>
              <div className="mobile-topbar-chat-title" title={activeThreadLabel}>
                <span className="mobile-topbar-title">{activeThreadLabel}</span>
              </div>
              <div className="mobile-topbar-chat-tools">
                {mobileChatChrome ? (
                  <ArtifactNavButton
                    artifactCount={mobileChatChrome.artifactCount}
                    inProject={mobileChatChrome.inProject}
                    onOpenArtifacts={mobileChatChrome.onToggleSpace}
                    expanded={mobileChatChrome.spaceOpen}
                    disabled={mobileChatChrome.spaceDisabled}
                  />
                ) : null}
                <SettingsButton route={route} href={hrefForRoute("settings")} onNavigate={() => onNavigateRoute("settings")} />
              </div>
            </>
          ) : (
            <>
              <Button variant="ghost"
                type="button"
                className={mobileView === "threads" ? "active" : ""}
                aria-label={directoryLabel}
                aria-pressed={mobileView === "threads"}
                onClick={() => onMobileViewChange("threads")}
              >
                <NavThreads size={ICON.md} /><span>{directoryLabel}</span>
              </Button>
              <Button variant="ghost"
                type="button"
                className={mobileView === "chat" ? "active" : ""}
                aria-pressed={mobileView === "chat"}
                onClick={() => onMobileViewChange("chat")}
              >
                <span>{activeThreadLabel}</span>
              </Button>
              <SettingsButton route={route} href={hrefForRoute("settings")} onNavigate={() => onNavigateRoute("settings")} />
            </>
          )
        ) : (
          <>
            <div className="mobile-topbar-route">
              <span className="mobile-topbar-eyebrow">{t(MOBILE_EYEBROW_KEYS[route] ?? "nav.mobile_section")}</span>
              <span className="mobile-topbar-title">{mobileRouteTitle}</span>
            </div>
            <SettingsButton route={route} href={hrefForRoute("settings")} onNavigate={() => onNavigateRoute("settings")} />
          </>
        )}
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
