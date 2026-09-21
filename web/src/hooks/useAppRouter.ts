"use client";

import { useCallback, useEffect, useState } from "react";
import { installNavigationHistory } from "../lib/navigationGuard";
import { rememberListUrl } from "../lib/recordBack";
import type { RelaySession } from "../types";
import {
  DEFAULT_ADMIN_SECTION,
  DEFAULT_SETTINGS_SECTION,
  type AdminSection,
  type AppRoute,
  type MobileView,
  type SettingsSection,
} from "../lib/viewTypes";
import {
  APP_NAVIGATION_EVENT,
  canonicalBrowserUrl,
  hrefForRoute as buildHrefForRoute,
  parseAppPath,
  syncAppStateToUrl,
  type AppLocationState,
} from "../lib/appRoute";

type UseAppRouterOptions = {
  composingNew: boolean;
  activeSessionId: string | null;
  selectedSessionId: string | undefined;
  activeSession: RelaySession | undefined;
  onApplySessionFromPath: (sessionId: string) => void;
  onSetComposingNewFromPath: (composingNew: boolean) => void;
  onClearPendingMessage: () => void;
};

export function useAppRouter({
  composingNew,
  activeSessionId,
  selectedSessionId,
  activeSession,
  onApplySessionFromPath,
  onSetComposingNewFromPath,
  onClearPendingMessage,
}: UseAppRouterOptions) {
  const [locationState, setLocationState] = useState<AppLocationState>({
    route: "main",
    mobileView: "threads",
    sessionId: null,
  });

  const applyLocationState = useCallback((state: AppLocationState) => {
    setLocationState(state);
    onSetComposingNewFromPath(Boolean(state.composingNew));
    if (state.composingNew) {
      onClearPendingMessage();
    } else if ((state.route === "main" || state.route === "projects" || state.route === "backlog") && state.sessionId) {
      onClearPendingMessage();
      onApplySessionFromPath(state.sessionId);
    }
  }, [onApplySessionFromPath, onClearPendingMessage, onSetComposingNewFromPath]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.pathname === "/") window.history.replaceState(window.history.state, "", "/threads");
    else {
      const canonicalUrl = canonicalBrowserUrl(window.location.pathname, window.location.search);
      if (`${window.location.pathname}${window.location.search}` !== canonicalUrl) {
        window.history.replaceState(window.history.state, "", canonicalUrl);
      }
    }

    const releaseHistory = installNavigationHistory();
    const applyCurrentLocation = () => applyLocationState(parseAppPath(window.location.pathname, window.location.search));
    applyCurrentLocation();
    window.addEventListener("popstate", applyCurrentLocation);
    window.addEventListener(APP_NAVIGATION_EVENT, applyCurrentLocation);
    return () => {
      releaseHistory();
      window.removeEventListener("popstate", applyCurrentLocation);
      window.removeEventListener(APP_NAVIGATION_EVENT, applyCurrentLocation);
    };
  }, [applyLocationState]);

  const navigateToAppState = useCallback((state: AppLocationState, replace = false) => {
    void syncAppStateToUrl(state, replace, () => applyLocationState(state));
  }, [applyLocationState]);

  const currentSessionId = !composingNew
    ? activeSession?.id ?? selectedSessionId ?? activeSessionId
    : null;

  const navigateToRoute = useCallback((nextRoute: AppRoute) => {
    navigateToAppState({
      route: nextRoute,
      mobileView: nextRoute === "main" || nextRoute === "projects" ? "threads" : "chat",
      sessionId: null,
    });
  }, [navigateToAppState]);

  const navigateToMobileView = useCallback((nextMobileView: MobileView) => {
    if (locationState.route === "backlog" && locationState.taskId) {
      navigateToAppState({ ...locationState, sessionId: nextMobileView === "chat" ? currentSessionId : null, mobileView: "chat" });
      return;
    }
    const threadRoute = locationState.route === "projects" ? "projects" : "main";
    navigateToAppState({
      route: threadRoute,
      mobileView: nextMobileView,
      sessionId: nextMobileView === "chat" ? currentSessionId ?? null : null,
      projectId: locationState.projectId ?? activeSession?.projectId ?? null,
      composingNew: nextMobileView === "chat" && composingNew,
    });
  }, [activeSession?.projectId, composingNew, currentSessionId, locationState, navigateToAppState]);

  const hrefForSideNavRoute = useCallback((nextRoute: AppRoute) => buildHrefForRoute(nextRoute), []);

  const syncThreadUrl = useCallback((sessionId: string | null, replace = false, projectId?: string | null, taskId?: string | null) => {
    const parentTaskId = taskId ?? (locationState.route === "backlog" ? locationState.taskId : null);
    const state: AppLocationState = {
      route: sessionId && parentTaskId ? "backlog" : sessionId ? "main" : projectId ? "projects" : "main",
      taskId: sessionId ? parentTaskId : null,
      mobileView: "chat",
      sessionId,
      projectId: projectId ?? null,
      composingNew: sessionId === null,
    };
    void syncAppStateToUrl(state, replace, () => setLocationState(state));
  }, [locationState.route, locationState.taskId]);

  /* The record routes. `null` returns to the list, which is what a breadcrumb
     does when the reader arrived by deep link and has no history to go back
     to — see `navigateBackToList` in lib/recordBack. */
  const navigateToTaskRecord = useCallback((taskId: string | null) => {
    if (taskId) rememberListUrl();
    navigateToAppState({ route: "backlog", mobileView: "chat", sessionId: null, taskId });
  }, [navigateToAppState]);

  const navigateToRoutineRecord = useCallback((routineId: string | null, runId: string | null = null) => {
    if (routineId) rememberListUrl();
    navigateToAppState({ route: "routine", mobileView: "chat", sessionId: null, taskId: routineId, runId });
  }, [navigateToAppState]);

  const navigateToAgent = useCallback((agentId: string | null) => {
    navigateToAppState({ route: "agents", mobileView: "chat", sessionId: null, agentId });
  }, [navigateToAppState]);

  const navigateToSettings = useCallback((section: SettingsSection) => {
    navigateToAppState({ route: "settings", mobileView: "chat", sessionId: null, settingsSection: section });
  }, [navigateToAppState]);

  const navigateToAdminSection = useCallback((section: AdminSection) => {
    navigateToAppState({ route: "admin", mobileView: "chat", sessionId: null, adminSection: section });
  }, [navigateToAppState]);

  const navigateToTeamWorkspace = useCallback((teamId: string | null) => {
    navigateToAppState({ route: "teams", mobileView: "chat", sessionId: null, teamWorkspaceId: teamId });
  }, [navigateToAppState]);

  const navigateToProject = useCallback((projectId: string | null) => {
    navigateToAppState({
      route: "projects",
      mobileView: projectId ? "chat" : "threads",
      sessionId: null,
      projectId,
    });
  }, [navigateToAppState]);

  const navigateToLogin = useCallback((replace = false) => {
    navigateToAppState({ route: "main", mobileView: "chat", sessionId: null, login: true }, replace);
  }, [navigateToAppState]);

  return {
    route: locationState.route,
    mobileView: locationState.mobileView,
    routedSessionId: locationState.sessionId,
    projectId: locationState.projectId ?? null,
    agentId: locationState.agentId ?? null,
    recordTaskId: locationState.taskId ?? null,
    recordRunId: locationState.runId ?? null,
    teamWorkspaceId: locationState.teamWorkspaceId ?? null,
    settingsSection: locationState.settingsSection ?? DEFAULT_SETTINGS_SECTION,
    adminSection: locationState.adminSection ?? DEFAULT_ADMIN_SECTION,
    notFound: Boolean(locationState.notFound),
    isLoginPath: Boolean(locationState.login),
    navigateToAppState,
    navigateToRoute,
    navigateToMobileView,
    hrefForSideNavRoute,
    syncThreadUrl,
    navigateToAgent,
    navigateToTaskRecord,
    navigateToRoutineRecord,
    navigateToSettings,
    navigateToAdminSection,
    navigateToTeamWorkspace,
    navigateToProject,
    navigateToLogin,
  };
}
