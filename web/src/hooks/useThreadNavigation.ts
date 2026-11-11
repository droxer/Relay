"use client";

import { sessionComputer } from "../lib/workspaceScope";
import { type RefObject } from "react";
import type { ComposerHandle } from "../components/composer/Composer";
import type { RelaySession, RelayTaskSummary } from "../types";
import type { AppRoute } from "../lib/viewTypes";
import { useComposerTargetStore } from "../lib/composerTargetStore";
import { useRelayStore } from "../lib/store";
import { resolveNewThreadComputer } from "../lib/threadRuntime";

type ThreadComputer = Parameters<typeof resolveNewThreadComputer>[1][number];

interface ThreadNavigationInput {
  route: AppRoute;
  myThreads: RelaySession[];
  projects?: readonly {id:string;managerThreadId?:string|null}[];
  projectsReady?: boolean;
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
  syncThreadUrl: (sessionId: string | null, replace?: boolean, projectId?: string | null, taskId?: string | null, computerId?: string | null) => void;
  navigateToProject: (projectId: string | null) => void;
}

/** Opening a thread, staging a new one, and picking a project — plus the
    keeping each conversation in its owning workspace. */
export function useThreadNavigation({
  route,
  myThreads,
  tasks,
  routedProjectId,
  recordTaskId,
  threadComputers,
  assignableComputers,
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

  function openThread(sessionId: string, replace = false, parentTaskId?: string) {
    const session = myThreads.find((candidate) => candidate.id === sessionId);
    const ownerTaskId = tasks.find((task) => task.linkedSessionIds.includes(sessionId))?.id;
    const taskId = parentTaskId ?? (route === "main" ? null : ownerTaskId ?? (route === "backlog" ? recordTaskId : null));
    // useThreadComposerSelection owns restoration and the thread's default.
    // Reopening the active thread must not reset its automatic agent pick.
    openSession(sessionId);
    if (taskId) showThreadList();
    syncThreadUrl(sessionId, replace, session ? session.projectId ?? null : routedProjectId,
      taskId, session ? sessionComputer(session, threadComputers) : null);
  }

  function startNewThread(projectId: string | null = routedProjectId) {
    pickRoom();
    startComposing();
    // Same rule as the staging effect: a pick survives a heartbeat flap, and
    // only a machine that is no longer this user's drops it.
    setNewThreadNodeId((current) => resolveNewThreadComputer(current, threadComputers, assignableComputers));
    pinTranscriptToBottom();
    syncThreadUrl(null, false, projectId);
  }

  function selectProject(projectId: string | null) {
    pickRoom();
    setComposingNew(false);
    clearSelection();
    navigateToProject(projectId);
  }

  return { openThread, startNewThread, selectProject };
}
