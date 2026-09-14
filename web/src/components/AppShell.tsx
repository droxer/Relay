"use client";

import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ICON,
  NavPreferences,
  NavThreads,
} from "./icons";
import { PreferencesDialog } from "./PreferencesDialog";
import type { Theme, Language } from "./PreferencesPanel";
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
import { useRelayStore } from "@/lib/store";
import { Button } from "@/components/ui/button";

const WORK_ROUTE_LABEL_KEYS: Record<Exclude<AppRoute, "main" | "projects">, string> = {
  backlog: "nav.backlog",
  routine: "nav.routine",
  agents: "nav.agents",
  teams: "nav.teams",
  skills: "nav.skills",
  channels: "nav.channels",
  admin: "nav.admin",
  computer: "nav.computer",
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
  prefsOpen: boolean;
  setPrefsOpen: Dispatch<SetStateAction<boolean>>;
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
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  language: Language;
  onLanguageChange: (language: Language) => void;
};

function PreferencesButton({ prefsOpen, setPrefsOpen }: { prefsOpen: boolean; setPrefsOpen: Dispatch<SetStateAction<boolean>> }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      type="button"
      className={`mobile-settings ${prefsOpen ? "active" : ""}`}
      aria-label={t("nav.preferences")}
      aria-haspopup="dialog"
      aria-expanded={prefsOpen}
      onClick={() => setPrefsOpen((v) => !v)}
    >
      <NavPreferences size={ICON.md} />
    </Button>
  );
}

export function AppShell({
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
  prefsOpen,
  setPrefsOpen,
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
  language,
  onLanguageChange,
}: AppShellProps) {
  const { t } = useTranslation();
  const adminView = useRelayStore((state) => state.adminView);
  const isAdmin = user.role === "admin";
  const [commandOpen, setCommandOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const queueNewTask = useCallback(() => {
    // Queue before navigating: the event notifies a mounted backlog directly,
    // and the one-shot flag survives the route change for a mounting one.
    taskCreateIntent()?.queue();
    if (route !== "backlog") onNavigateRoute("backlog");
  }, [onNavigateRoute, route]);

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
        setPrefsOpen(true);
        break;
      case "shortcuts-help":
        setShortcutsOpen(true);
        break;
    }
  }, [onNavigateRoute, onNewThread, onThemeChange, queueNewTask, setPrefsOpen, setSidenavExpanded, sidenavExpanded, theme]);

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

  const isThreadRoute = route === "main" || route === "projects";
  const directoryLabel = route === "projects" ? t("project.projects") : t("nav.threads");
  const mobileRouteTitle = route === "admin"
    ? t(`admin.v2.title_${adminView}`)
    : isThreadRoute
      ? directoryLabel
      : t(WORK_ROUTE_LABEL_KEYS[route]);
  const isMobileChat = isThreadRoute && mobileView === "chat";

  return (
    <div
      className="messenger-shell"
      data-mobile-view={mobileView}
      data-route={route}
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
                <NavThreads size={ICON.md} />
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
                <PreferencesButton prefsOpen={prefsOpen} setPrefsOpen={setPrefsOpen} />
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
              <PreferencesButton prefsOpen={prefsOpen} setPrefsOpen={setPrefsOpen} />
            </>
          )
        ) : (
          <>
            <div className="mobile-topbar-route">
              <span className="mobile-topbar-eyebrow">{route === "admin" ? t("nav.admin") : t("nav.mobile_section")}</span>
              <span className="mobile-topbar-title">{mobileRouteTitle}</span>
            </div>
            <PreferencesButton prefsOpen={prefsOpen} setPrefsOpen={setPrefsOpen} />
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
        prefsOpen={prefsOpen}
        setPrefsOpen={setPrefsOpen}
        onLogout={onLogout}
        onOpenCommandMenu={() => setCommandOpen(true)}
      />

      {/* display:contents (owned by shell.css, .messenger-shell > main) keeps
          the route panels as direct grid items of .messenger-shell while the
          <main> landmark stays a sibling of the SideNav <nav>. */}
      <main>
        {children}
      </main>

      <PreferencesDialog
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        preferences={{
          theme,
          onThemeChange,
          language,
          onLanguageChange,
        }}
      />

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
