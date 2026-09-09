"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  assignTask,
  archiveProject,
  cancelRun,
  createTask,
  createProject,
  createTeam,
  deleteSession,
  deleteTask,
  deleteTeam,
  RelayApiError,
  recordDecision,
  renameSession,
  requestThreadRecovery,
  runSandbox,
  runLogicalAgents,
  startTask,
  submitThreadMessage,
  updateTask,
  updateProject,
  updateTeam,
} from "../api";
import type { AgentRunInput, CreateProjectInput, CreateTaskInput, ProjectRecord, RelaySession, RelayTask, RelayTaskSummary, RunInput, TaskMutationInput, TaskRunAssignment, TeamMutationInput, ThreadMessageInput, ThreadRecoveryInput, UpdateProjectInput } from "../types";
import { NODES_QUERY_KEY, PROJECTS_QUERY_KEY, RELAY_QUERY_KEY, SESSIONS_QUERY_KEY, TASKS_QUERY_KEY } from "./useRelayData";
import { useMutationError } from "./useMutationError";
import { useDialogs } from "../components/ui/DialogProvider";
import { TEAMS_QUERY_KEY } from "./useTeams";
import { mergeSessionSnapshotIntoSessions } from "../lib/sessionPollMerge";
import { applySessionEventUnchecked } from "../lib/sessionEvents";
import { mergeTaskSummaryIntoTasks, taskSummaryFromTask } from "../lib/taskSummary";
import { batchOutcome, type BatchOutcome } from "../lib/taskSelection";
import { mergeProjectIntoProjects } from "../lib/projectDirectory";

type TokenArg = { token?: string };

export function useRelayMutations() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const { reportMutationError } = useMutationError();

  const invalidateRelay = () => queryClient.invalidateQueries({ queryKey: RELAY_QUERY_KEY });
  const invalidateSessions = () => queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY, exact: true });
  const invalidateTasks = () => queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY, exact: true });
  const invalidateNodes = () => queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY, exact: true });
  const invalidateProjects = () => queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true });
  const invalidateTeams = () => queryClient.invalidateQueries({ queryKey: [TEAMS_QUERY_KEY] });
  const cacheSession = (session: RelaySession) => {
    queryClient.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, (current) =>
      mergeSessionSnapshotIntoSessions(
        current ?? [],
        session,
        applySessionEventUnchecked,
      ));
  };
  const cacheTask = (task: RelayTask) => {
    const summary = taskSummaryFromTask(task);
    queryClient.setQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY, (current) =>
      mergeTaskSummaryIntoTasks(current ?? [], summary));
  };
  const cacheProject = (project: ProjectRecord) => {
    queryClient.setQueryData<ProjectRecord[]>(PROJECTS_QUERY_KEY, (current) =>
      mergeProjectIntoProjects(current ?? [], project));
  };

  const onRelayError = (context: string, messageKey: string) => (error: unknown) => {
    reportMutationError(context, error, t(messageKey));
  };

  const renameSessionMutation = useMutation({
    mutationFn: ({ sessionId, title, token }: { sessionId: string; title: string } & TokenArg) =>
      renameSession(sessionId, title, token),
    onSuccess: cacheSession,
    onError: onRelayError("Failed to rename thread", "errors.rename_thread"),
  });

  const deleteSessionMutation = useMutation({
    mutationFn: ({ sessionId, token }: { sessionId: string } & TokenArg) => deleteSession(sessionId, token),
    onMutate: async ({ sessionId }) => {
      await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
      const previous = queryClient.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY);
      queryClient.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, (current) =>
        (current ?? []).filter((session) => session.id !== sessionId),
      );
      return { deleted: previous?.find((session) => session.id === sessionId) };
    },
    onSuccess: () => {
      void invalidateSessions();
      void invalidateTasks();
    },
    onError: (error, _input, context) => {
      if (context?.deleted) {
        const deleted = context.deleted;
        queryClient.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, (current) =>
          current?.some((session) => session.id === deleted.id)
            ? current
            : [deleted, ...(current ?? [])]);
      }
      void invalidateSessions();
      onRelayError("Failed to delete thread", "errors.delete_thread")(error);
    },
  });

  const cancelRunMutation = useMutation({
    mutationFn: ({
      sessionId,
      token,
      reason,
    }: { sessionId: string; reason?: string } & TokenArg) =>
      cancelRun(sessionId, token, reason),
    onSuccess: (session) => {
      cacheSession(session);
      void invalidateNodes();
      void invalidateTasks();
    },
    onError: onRelayError("Failed to cancel active run", "errors.cancel_run"),
  });

  const recordDecisionMutation = useMutation({
    mutationFn: ({
      sessionId,
      kind,
      note,
      token,
    }: { sessionId: string; kind: "approve" | "reject" | "mark_done"; note?: string } & TokenArg) =>
      recordDecision(sessionId, kind, note, token),
    onSuccess: (session) => {
      cacheSession(session);
      void invalidateTasks();
    },
    onError: onRelayError("Failed to record decision", "errors.record_decision"),
  });

  const runSandboxMutation = useMutation({
    mutationFn: ({ input, token }: { input: RunInput; token?: string }) => runSandbox(input, token),
    onSuccess: (session) => {
      cacheSession(session);
      void invalidateNodes();
    },
  });

  const runLogicalAgentsMutation = useMutation({
    mutationFn: (input: AgentRunInput) => runLogicalAgents(input),
    onSuccess: (session) => {
      cacheSession(session);
      void invalidateNodes();
    },
  });

  const submitThreadMessageMutation = useMutation({
    mutationFn: ({ sessionId, input }: { sessionId: string; input: ThreadMessageInput }) =>
      submitThreadMessage(sessionId, input),
    onSuccess: (session) => {
      cacheSession(session);
      void invalidateNodes();
    },
  });

  const requestThreadRecoveryMutation = useMutation({
    mutationFn: ({ sessionId, input }: { sessionId: string; input: ThreadRecoveryInput }) =>
      requestThreadRecovery(sessionId, input),
    onSuccess: (session) => {
      cacheSession(session);
      void invalidateNodes();
      void invalidateTasks();
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: (input: CreateTaskInput) => createTask(input),
    onSuccess: cacheTask,
    onError: onRelayError("Failed to create task", "errors.save_task"),
  });

  // Status is applied to the cache up front so a card dragged between board
  // lanes lands immediately instead of springing back until the PATCH returns.
  // Only status is patched optimistically: it is a plain enum the board reads
  // directly, whereas the drawer's other fields are normalized server-side and
  // their latency is hidden by the drawer closing anyway.
  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: TaskMutationInput }) => updateTask(taskId, input),
    onMutate: async ({ taskId, input }: { taskId: string; input: TaskMutationInput }) => {
      const status = input.status;
      if (!status) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY });
      const previous = queryClient.getQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY);
      queryClient.setQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY, (current) =>
        (current ?? []).map((task) => (task.id === taskId ? { ...task, status } : task)),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(TASKS_QUERY_KEY, context.previous);
      onRelayError("Failed to update task", "errors.save_task")(error);
    },
    // Settled, not success: a rolled-back failure must resync from the server
    // too, otherwise the board keeps showing the pre-mutation snapshot.
    onSuccess: cacheTask,
    onSettled: () => void invalidateTasks(),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: ({ taskId }: { taskId: string }) => deleteTask(taskId),
    onSuccess: (_result, { taskId }) => {
      queryClient.setQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY, (current) =>
        (current ?? []).filter((task) => task.id !== taskId));
    },
    onError: (error: unknown) => {
      const messageKey = error instanceof RelayApiError && error.code === "task_execution_active"
        ? "errors.task_execution_active"
        : "errors.delete_task";
      onRelayError("Failed to delete task", messageKey)(error);
    },
  });

  // Batch delete from the board's selection bar. There is no bulk endpoint, so
  // the requests fan out and settle independently: one task that refuses to
  // delete (active work) must not strand the rest. The mutation resolves with
  // a per-record outcome and the caller reports the partial result — a batch
  // that half-failed is never announced as a clean success.
  const deleteTasksMutation = useMutation({
    mutationFn: async ({ taskIds }: { taskIds: readonly string[] }): Promise<BatchOutcome> => {
      const results = await Promise.allSettled(taskIds.map((taskId) => deleteTask(taskId)));
      return batchOutcome(taskIds, results);
    },
    onSuccess: ({ succeeded, failed }) => {
      if (succeeded.length > 0) {
        const removed = new Set(succeeded);
        queryClient.setQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY, (current) =>
          (current ?? []).filter((task) => !removed.has(task.id)));
      }
      // One toast for the batch, not one per record: a selection of twenty
      // blocked tasks would otherwise bury the board in identical messages.
      if (failed.length > 0) {
        const active = failed.find(({ error }) => error instanceof RelayApiError && error.code === "task_execution_active");
        const messageKey = active ? "errors.task_execution_active" : "errors.delete_task";
        reportMutationError("Failed to delete tasks", failed[0].error, t(messageKey));
      }
    },
    onError: onRelayError("Failed to delete tasks", "errors.delete_task"),
    onSettled: () => void invalidateTasks(),
  });

  const assignTaskMutation = useMutation({
    mutationFn: ({ taskId, agentId }: { taskId: string; agentId: string }) => assignTask(taskId, agentId),
    onSuccess: cacheTask,
    onError: onRelayError("Failed to assign task", "errors.task_action"),
  });

  const startTaskMutation = useMutation({
    mutationFn: ({
      taskId,
      ...input
    }: {
      taskId: string;
      assignments?: TaskRunAssignment[];
    }) => startTask(taskId, input),
    onSuccess: (result) => {
      cacheTask(result.task);
      if (result.session) cacheSession(result.session);
      void invalidateNodes();
      announce({
        message:
          result.dispatch.message ??
          (result.dispatch.state === "rejected"
            ? t("backlog.toast_start_rejected")
            : t("backlog.toast_started")),
        tone: result.dispatch.state === "rejected"
          ? "error"
          : result.dispatch.state === "started"
            ? "success"
            : "info",
      });
    },
    onError: onRelayError("Failed to start task", "errors.task_action"),
  });

  const createTeamMutation = useMutation({
    mutationFn: (input: TeamMutationInput) => createTeam(input),
    onSuccess: () => {
      void invalidateTeams();
    },
    onError: onRelayError("Failed to create team", "errors.save_team"),
  });

  const createProjectMutation = useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: ({ project }) => {
      cacheProject(project);
      void invalidateProjects();
    },
    onError: onRelayError("Failed to create project", "errors.save_project"),
  });

  const updateProjectMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: UpdateProjectInput }) =>
      updateProject(projectId, input),
    onSuccess: ({ project }) => {
      cacheProject(project);
      void invalidateProjects();
    },
    onError: onRelayError("Failed to update project", "errors.save_project"),
  });

  const archiveProjectMutation = useMutation({
    mutationFn: ({ projectId, expectedVersion }: { projectId: string; expectedVersion: number }) =>
      archiveProject(projectId, expectedVersion),
    onSuccess: ({ project }) => {
      cacheProject(project);
      void invalidateProjects();
      void invalidateSessions();
      void invalidateTasks();
    },
    onError: onRelayError("Failed to archive project", "errors.archive_project"),
  });

  const updateTeamMutation = useMutation({
    mutationFn: ({ teamId, input }: { teamId: string; input: Partial<TeamMutationInput> }) =>
      updateTeam(teamId, input),
    onSuccess: () => {
      void invalidateTeams();
      void invalidateTasks();
    },
    onError: onRelayError("Failed to update team", "errors.save_team"),
  });

  const deleteTeamMutation = useMutation({
    mutationFn: (teamId: string) => deleteTeam(teamId),
    onSuccess: () => {
      void invalidateTeams();
      void invalidateTasks();
    },
    onError: onRelayError("Failed to delete team", "errors.delete_team"),
  });

  return {
    renameSessionMutation,
    deleteSessionMutation,
    cancelRunMutation,
    recordDecisionMutation,
    runSandboxMutation,
    runLogicalAgentsMutation,
    submitThreadMessageMutation,
    requestThreadRecoveryMutation,
    createTaskMutation,
    updateTaskMutation,
    deleteTaskMutation,
    deleteTasksMutation,
    assignTaskMutation,
    startTaskMutation,
    createTeamMutation,
    createProjectMutation,
    updateProjectMutation,
    archiveProjectMutation,
    updateTeamMutation,
    deleteTeamMutation,
    invalidateRelay,
  };
}

export type RunSandboxMutationResult = RelaySession;
