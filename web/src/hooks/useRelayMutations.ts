"use client";

import { taskFlowErrorKey } from "../lib/taskFlow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  assignTask,
  answerPermissionRequest,
  archiveProject,
  deleteProject,
  cancelRun,
  createTask,
  createProject,
  startProjectSetup,
  createTeam,
  deleteSession,
  deleteTask,
  deleteTeam,
  RelayApiError,
  recordDecision,
  renameSession,
  requestThreadRecovery,
  resumeAutomation,
  runLogicalAgents,
  startTask,
  submitThreadMessage,
  updateTask,
  updateProject,
  updateTeam,
} from "../api";
import type { AgentRunInput, CreateProjectInput, StartProjectSetupInput, CreateTaskInput, ProjectRecord, RelaySession, RelayTask, RelayTaskSummary, TaskMutationInput, TaskRunAssignment, TeamMutationInput, ThreadMessageInput, ThreadRecoveryInput, UpdateProjectInput } from "../types";
import { NODES_QUERY_KEY, PROJECTS_QUERY_KEY, SESSIONS_QUERY_KEY, TASKS_QUERY_KEY } from "./useRelayData";
import { useMutationError } from "./useMutationError";
import { useDialogs } from "../components/ui/DialogProvider";
import { TEAMS_QUERY_KEY } from "./useTeams";
import { TASK_RECORD_QUERY_KEY } from "./useTaskRecord";
import { mergeSessionSnapshotIntoSessions } from "../lib/sessionPollMerge";
import { applySessionEventUnchecked } from "../lib/sessionEvents";
import { mergeTaskSummaryIntoTasks, taskSummaryFromTask } from "../lib/taskSummary";
import { batchOutcome, type BatchOutcome } from "../lib/taskSelection";
import { mergeProjectIntoProjects } from "../lib/projectDirectory";
import { projectCleanupNotice, projectDeleteErrorMessage } from "../lib/projectDeletion";
import { threadLabel } from "../lib/threads";

type TokenArg = { token?: string };

export function useRelayMutations() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const { reportMutationError } = useMutationError();

  const invalidateSessions = () => queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY, exact: true });
  const invalidateTasks = () => queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY, exact: true });
  const invalidateNodes = () => queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY, exact: true });
  const invalidateProjects = () => queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true });
  // Prefix on purpose: the teams list is keyed ["teams", userId] and nothing
  // else lives under "teams", so `exact` here would match no query at all.
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
    onSuccess: (execution, { sessionId }) => {
      queryClient.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, (current) =>
        execution
          ? (current ?? []).map((session) => session.id === sessionId
            ? { ...session, execution, deletionRequestedAt: session.deletionRequestedAt ?? new Date().toISOString() }
            : session)
          : (current ?? []).filter((session) => session.id !== sessionId));
      void invalidateSessions();
      void invalidateTasks();
    },
    onError: onRelayError("Failed to delete thread", "errors.delete_thread"),
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

  const answerPermissionMutation = useMutation({
    mutationFn: ({
      sessionId,
      requestId,
      decision,
      note,
      token,
    }: { sessionId: string; requestId: string; decision: "allow" | "deny"; note?: string } & TokenArg) =>
      answerPermissionRequest(sessionId, requestId, decision, note, token),
    onSuccess: (session) => cacheSession(session),
    onError: (error: unknown) => {
      // Someone answered first, or the run ended: the stream will drop the card.
      const messageKey = error instanceof RelayApiError && error.code === "permission_request_closed"
        ? "errors.permission_request_closed"
        : "errors.answer_permission";
      onRelayError("Failed to answer permission request", messageKey)(error);
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
    onSuccess: (session, { input }) => {
      cacheSession(session);
      void invalidateNodes();
      // An answer moves its task off the wait; show that without a poll.
      if (input.questionId) void invalidateTasks();
    },
    onError: (error) => {
      // The question was answered or replaced elsewhere: fetch the one the
      // task waits on now, so the prompt stops offering the stale one.
      if (error instanceof RelayApiError && error.code === "question_superseded") void invalidateTasks();
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

  // Status, priority and due date are applied to the cache up front so a drag
  // or an inline row edit lands immediately instead of springing back until
  // the PATCH returns. They are plain values the lists read directly; the
  // drawer's other fields are normalized server-side and their latency is
  // hidden by the drawer closing anyway.
  const updateTaskMutation = useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: TaskMutationInput }) => updateTask(taskId, input),
    onMutate: async ({ taskId, input }: { taskId: string; input: TaskMutationInput }) => {
      const { status, priority, dueDate, assignedAgentId, assignedTeamId } = input;
      const assignmentChanged = assignedAgentId !== undefined || assignedTeamId !== undefined;
      if (!status && !priority && dueDate === undefined && !assignmentChanged) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY });
      const previous = queryClient.getQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY);
      queryClient.setQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY, (current) =>
        (current ?? []).map((task) => {
          if (task.id !== taskId) return task;
          return {
            ...task,
            ...(status ? { status, workflowStage: status === "blocked" || status === "waiting_for_human" ? task.workflowStage : status } : {}),
            // A task moved off its wait no longer asks anything.
            ...(status && status !== "waiting_for_human" ? { awaiting: null } : {}),
            ...(priority ? { priority } : {}),
            ...(dueDate !== undefined ? { dueDate: dueDate || undefined } : {}),
            ...(assignmentChanged
              ? {
                  assignedAgentId: assignedAgentId || undefined,
                  assignedTeamId: assignedTeamId || undefined,
                  ...(assignedAgentId ? {} : { assignedAgent: undefined }),
                }
              : {}),
          };
        }),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(TASKS_QUERY_KEY, context.previous);
      const key = error instanceof RelayApiError ? taskFlowErrorKey(error.code) : undefined;
      onRelayError("Failed to update task", key ?? "errors.save_task")(error);
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
    onSettled: () => {
      void invalidateTasks();
      void invalidateSessions();
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
    onSettled: () => {
      void invalidateTasks();
      void invalidateSessions();
    },
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
          (result.dispatch.code === "task_wip_limit" ? t("backlog.wip_wait") : result.dispatch.message) ??
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

  const resumeAutomationMutation = useMutation({
    mutationFn: ({ taskId }: { taskId: string }) => resumeAutomation(taskId),
    onSuccess: (task) => {
      cacheTask(task);
      announce({ message: t("automation.resumed_toast"), tone: "success" });
    },
    onError: onRelayError("Failed to resume automation", "errors.task_action"),
    onSettled: (_task, _error, { taskId }) => {
      void invalidateTasks();
      void queryClient.invalidateQueries({ queryKey: [TASK_RECORD_QUERY_KEY, taskId] });
    },
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

  const startProjectSetupMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: StartProjectSetupInput }) =>
      startProjectSetup(projectId, input),
    onSuccess: ({ project }) => {
      cacheProject(project);
      void invalidateProjects();
    },
    onError: onRelayError("Failed to start project setup", "errors.start_project_setup"),
  });

  const updateProjectMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: UpdateProjectInput }) =>
      updateProject(projectId, input),
    onSuccess: ({ project }) => {
      cacheProject(project);
      void invalidateProjects();
    },
    onError: (error) => {
      // Project editors reconcile version conflicts and show a confirmation.
      // A generic failure toast here incorrectly blames the computer/roster.
      if (error instanceof RelayApiError && error.code === "project_version_conflict") return;
      onRelayError("Failed to update project", "errors.save_project")(error);
    },
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

  const deleteProjectMutation = useMutation({
    mutationFn: ({ projectId, expectedVersion }: { projectId: string; expectedVersion: number }) =>
      deleteProject(projectId, expectedVersion),
    onSuccess: async ({ deletedProjectId, workspaceCleanup, detachedTaskIds }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: PROJECTS_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY }),
      ]);
      queryClient.setQueryData<ProjectRecord[]>(PROJECTS_QUERY_KEY, (current) =>
        current?.filter((project) => project.id !== deletedProjectId));
      queryClient.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, (current) =>
        current?.filter((session) => session.projectId !== deletedProjectId));
      queryClient.setQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY, (current) =>
        current?.filter((task) => task.projectId !== deletedProjectId));
      await Promise.all([invalidateProjects(), invalidateSessions(), invalidateTasks()]);
      queryClient.removeQueries({ queryKey: ["workspace-files", `project:${deletedProjectId}`] });
      queryClient.removeQueries({ queryKey: ["workspace-file", `project:${deletedProjectId}`] });
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] === "task-record"
        && (query.state.data as RelayTask | undefined)?.projectId === deletedProjectId });
      const cleanup = projectCleanupNotice(workspaceCleanup);
      const detached = detachedTaskIds?.length
        ? ` ${t("project.tasks_detached", { count: detachedTaskIds.length })}`
        : "";
      announce({
        message: `${t("project.deleted")}. ${t(cleanup.key)}${detached}`,
        tone: cleanup.tone,
      });
    },
    onError: (error: unknown) => {
      // A stale version means the project changed underneath the dialog; load
      // the current one so the next attempt can succeed.
      if (error instanceof RelayApiError && error.code === "project_version_conflict") void invalidateProjects();
      const sessions = queryClient.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY) ?? [];
      const message = projectDeleteErrorMessage(error, (sessionId) => {
        const session = sessions.find((candidate) => candidate.id === sessionId);
        return session ? threadLabel(session) : undefined;
      });
      reportMutationError("Failed to delete project", error, t(message.key, message.values));
    },
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
    answerPermissionMutation,
    runLogicalAgentsMutation,
    submitThreadMessageMutation,
    requestThreadRecoveryMutation,
    createTaskMutation,
    updateTaskMutation,
    deleteTaskMutation,
    deleteTasksMutation,
    assignTaskMutation,
    startTaskMutation,
    resumeAutomationMutation,
    createTeamMutation,
    createProjectMutation,
    startProjectSetupMutation,
    updateProjectMutation,
    archiveProjectMutation,
    deleteProjectMutation,
    updateTeamMutation,
    deleteTeamMutation,
  };
}
