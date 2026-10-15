"use client";

import { useEffect, type RefObject } from "react";
import type { ComposerHandle } from "../components/composer/Composer";
import type { RelaySession, RelayTaskSummary } from "../types";
import type { AppRoute } from "../lib/viewTypes";
import { hrefForRoute, navigateToAppPath } from "../lib/appRoute";
import { useComposerTargetStore } from "../lib/composerTargetStore";
import { useRelayStore } from "../lib/store";
import { taskCreateIntent } from "../lib/taskCreateIntent";
import { useThreadSendStore } from "../lib/threadSendStore";
import { resolveNewThreadComputer } from "../lib/threadRuntime";

type ThreadComputer = Parameters<typeof resolveNewThreadComputer>[1][number];

interface ThreadNavigationInput {
  route: AppRoute;
  myThreads: RelaySession[];
  tasks: RelayTaskSummary[];
  tasksStatus: string;
  activeSession: RelaySession | undefined;
  composingNew: boolean;
  routedSessionId: string | null;
  routedProjectId: string | null;
  recordTaskId: string | null;
  threadComputers: readonly ThreadComputer[];
  assignableComputers: readonly ThreadComputer[];
  composerRef: RefObject<ComposerHandle | null>;
  pinTranscriptToBottom: () => void;
  showThreadList: () => void;
  syncThreadUrl: (sessionId: string | null, replace?: boolean, projectId?: string | null, taskId?: string | null) => void;
  navigateToProject: (projectId: string | null) => void;
}

/** Opening a thread, staging a new one, and picking a project — plus the
    redirect that moves old project-thread links to where they live now. */
export function useThreadNavigation({
  route,
  myThreads,
  tasks,
  tasksStatus,
  activeSession,
  composingNew,
  routedSessionId,
  routedProjectId,
  recordTaskId,
  threadComputers,
  assignableComputers,
  composerRef,
  pinTranscriptToBottom,
  showThreadList,
  syncThreadUrl,
  navigateToProject,
}: ThreadNavigationInput) {
  const openSession = useRelayStore((s) => s.openSession);
  const startComposing = useRelayStore((s) => s.startComposing);
  const clearSelection = useRelayStore((s) => s.clearSelection);
  const setComposingNew = useRelayStore((s) => s.setComposingNew);
  const setNewThreadNodeId = useComposerTargetStore((s) => s.setNewThreadNodeId);
  const pickRoom = useComposerTargetStore((s) => s.pickRoom);
  const clearPendingTeam = useComposerTargetStore((s) => s.clearPendingTeam);
  const dropPendingMessage = useThreadSendStore((s) => s.dropPendingMessage);

  function openThread(sessionId: string, replace = false, parentTaskId?: string) {
    const session = myThreads.find((candidate) => candidate.id === sessionId);
    const ownerTaskId = tasks.find((task) => task.linkedSessionIds.includes(sessionId))?.id;
    const taskId = parentTaskId ?? (route === "main" ? null : ownerTaskId ?? (route === "backlog" ? recordTaskId : null));
    if (session?.projectId && !ownerTaskId && !taskId) {
      navigateToProject(session.projectId);
      return;
    }
    dropPendingMessage();
    clearPendingTeam();
    pickRoom();
    openSession(sessionId);
    if (taskId) showThreadList();
    syncThreadUrl(sessionId, replace, session?.projectId ?? routedProjectId,
      taskId);
  }

  // Old project thread links resolve to their task; standalone project rooms
  // no longer have a conversation surface. The redirect only fires while the
  // URL addresses the thread — a bare /threads is the list, and the sidenav's
  // Threads destination must stay there even when the active thread is a
  // project room.
  useEffect(() => {
    const projectId = routedProjectId ?? activeSession?.projectId;
    if ((route !== "projects" && route !== "main") || !projectId) return;
    if (route === "projects" && composingNew) {
      void navigateToAppPath(`${hrefForRoute("backlog")}?project=${encodeURIComponent(projectId)}`, { replace: true });
    } else if (tasksStatus === "ready" && !composingNew && activeSession
      && routedSessionId === activeSession.id) {
      const sessionId = activeSession.id;
      const taskId = tasks.find((task) => task.linkedSessionIds.includes(sessionId))?.id;
      if (route === "main" && taskId) return;
      const path = taskId
        ? `${hrefForRoute("backlog")}/${encodeURIComponent(taskId)}/threads/${encodeURIComponent(sessionId)}?project=${encodeURIComponent(projectId)}`
        : `/projects/${encodeURIComponent(projectId)}`;
      void navigateToAppPath(path, { replace: true });
    }
  }, [route, routedProjectId, routedSessionId, activeSession, composingNew, tasks, tasksStatus]);

  function startNewThread(projectId: string | null = null) {
    if (projectId) {
      taskCreateIntent()?.queue();
      void navigateToAppPath(`${hrefForRoute("backlog")}?project=${encodeURIComponent(projectId)}`);
      return;
    }
    pickRoom();
    startComposing();
    dropPendingMessage();
    // Same rule as the staging effect: a pick survives a heartbeat flap, and
    // only a machine that is no longer this user's drops it.
    setNewThreadNodeId((current) => resolveNewThreadComputer(current, threadComputers, assignableComputers));
    composerRef.current?.clear();
    pinTranscriptToBottom();
    syncThreadUrl(null, false, projectId);
  }

  function selectProject(projectId: string | null) {
    pickRoom();
    setComposingNew(false);
    dropPendingMessage();
    clearSelection();
    navigateToProject(projectId);
  }

  return { openThread, startNewThread, selectProject };
}
