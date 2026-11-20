"use client";

import { taskFlowErrorKey } from "../lib/taskFlow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  assignTask,
  answerPermissionRequest,
  setThreadPermissionMode,
  archiveProject,
  unarchiveProject,
  deleteProject,
  cancelRun,
  createTask,
  createProject,
  startProjectSetup,
applySetupTasks,
setTaskPrerequisites,
  createTeam,
  deleteSession,
  deleteTask,
  deleteTeam,
  RelayApiError,
  recordDecision,
  decideWorkflow,
  renameSession,
  requestThreadRecovery,
  resumeAutomation,
  runLogicalAgents,
  startTask,
  submitThreadMessage,
  updateTask,
  updateProject,
  updateTeam,
  updateTeamMemberConfig,
} from "../api";
import type { AgentRunInput, AgentTeam, AgentTeamsResponse, ApplySetupTasksInput, CreateProjectInput, StartProjectSetupInput, CreateTaskInput, ProjectListItem, ProjectRecord, RelaySession, RelayTask, RelayTaskSummary, TaskMutationInput, TaskRunAssignment, TeamMemberConfigPatch, TeamMutationInput, ThreadMessageInput, ThreadRecoveryInput, UpdateProjectInput } from "../types";
import { isTaskListScope } from "../domain-types/tasks";
import type { PermissionAnswerInput } from "../lib/permissionRequests";
import type { ThreadPermissionMode, WorkflowAttemptBinding } from "relay-core";
import { AUTOMATIONS_PAGE_KEY, COMPUTER_TASKS_QUERY_KEY, HOME_TASKS_QUERY_KEY, ISSUES_PAGE_KEY, NODES_QUERY_KEY, PROJECTS_QUERY_KEY, SESSIONS_QUERY_KEY, TASKS_QUERY_KEY, THREAD_TASKS_QUERY_KEY } from "./useRelayData";
import { useMutationError } from "./useMutationError";
import { WORKSPACE_ACTIVITY_QUERY_KEY } from "./useWorkspaceActivity";
import { useDialogs } from "../components/ui/DialogProvider";
import { teamRecordKey, TEAMS_QUERY_KEY } from "./useTeams";
import { TEAM_WORKFLOW_CHOICES_KEY } from "./useProjectWorkflows";
import { TASK_RECORD_QUERY_KEY } from "./useTaskRecord";
import { mergeSessionSnapshotIntoSessions } from "../lib/sessionPollMerge";
import { applySessionEventUnchecked, applySessionEventsUnchecked } from "../lib/sessionEvents";
import { mergeTaskSummaryIntoTasks, taskSummaryFromTask } from "../lib/taskSummary";
import { batchOutcome, type BatchOutcome } from "../lib/taskSelection";
import { mergeProjectIntoProjects, projectDirectoryEntry, projectIndexRow } from "../lib/projectDirectory";
import { PROJECT_DIRECTORY_ENTRY_QUERY_KEY, PROJECT_INDEX_QUERY_KEY, PROJECT_RECORD_QUERY_KEY, projectRecordKey } from "./projectQueries";
import type { ProjectIndexRow } from "../types";
import { projectCleanupNotice, projectDeleteBlockingThreadId, projectDeleteErrorMessage } from "../lib/projectDeletion";
import { threadLabel } from "../lib/threads";
import { THREAD_QUEUE_QUERY_KEY } from "../lib/threadQueue";
import { taskWorkflowSessionQueryKey } from "../lib/workflowRuns";
import { fetchSessionSnapshot } from "../lib/sessionSnapshotQuery";

type TokenArg = { token?: string };

export function useRelayMutations() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const { reportMutationError } = useMutationError();

  const invalidateSessions = () => queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY, exact: true });
  const invalidateWorkspaceActivity = () => queryClient.invalidateQueries({ queryKey: WORKSPACE_ACTIVITY_QUERY_KEY });
  const invalidateTasks = () => queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
  const invalidateIssues = () => queryClient.invalidateQueries({ queryKey: ISSUES_PAGE_KEY });
  const taskLists = () => queryClient.getQueriesData<RelayTaskSummary[]>({ queryKey: TASKS_QUERY_KEY })
    .filter((entry): entry is [typeof entry[0], RelayTaskSummary[]] => Array.isArray(entry[1]));
  const filterTaskLists = (keep: (task: RelayTaskSummary) => boolean) => {
    for (const [key] of taskLists()) {
      queryClient.setQueryData<RelayTaskSummary[]>(key, current => current?.filter(keep));
    }
  };
  const invalidateTaskProjections = (task: RelayTask) => {
    void invalidateIssues();
    if (task.isRoutine || task.sourceRoutineId) void queryClient.invalidateQueries({ queryKey: AUTOMATIONS_PAGE_KEY });
    void queryClient.invalidateQueries({ queryKey: THREAD_TASKS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: COMPUTER_TASKS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: HOME_TASKS_QUERY_KEY, exact: true });
    if (task.projectId) void queryClient.invalidateQueries({ queryKey: [...TASKS_QUERY_KEY, task.projectId] });
  };
  const invalidateThreadTasks = (sessionId: string) => {
    const linkedIds = new Set(taskLists().flatMap(([, rows]) =>
      rows.filter(task => task.linkedSessionIds?.includes(sessionId)).map(task => task.id)));
    // A deep-linked record can be cached before its list row is available.
    for (const [key, record] of queryClient.getQueriesData<RelayTask>({ queryKey: [TASK_RECORD_QUERY_KEY] })) {
      if (record?.linkedSessionIds?.includes(sessionId) || (typeof key[1] === "string" && linkedIds.has(key[1]))) {
        void queryClient.invalidateQueries({ queryKey: key, exact: true });
      }
    }
    return invalidateTasks();
  };
  const invalidateNodes = () => queryClient.invalidateQueries({ queryKey: NODES_QUERY_KEY, exact: true });
  const invalidateProjects = () => queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
  const invalidateTeamWorkflowChoices = () => queryClient.invalidateQueries({ queryKey: TEAM_WORKFLOW_CHOICES_KEY });
  const invalidateTaskWorkflowSession = (sessionId: string) =>
    queryClient.invalidateQueries({ queryKey: taskWorkflowSessionQueryKey(sessionId), exact: true });
  // Prefix on purpose: the teams list is keyed ["teams", userId] and nothing
  // else lives under "teams", so `exact` here would match no query at all.
  const invalidateTeams = () => queryClient.invalidateQueries({ queryKey: [TEAMS_QUERY_KEY] });
  const cacheSession = (session: RelaySession) => {
    queryClient.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, (current) =>
      mergeSessionSnapshotIntoSessions(
        current ?? [],
        session,
        applySessionEventUnchecked,
        applySessionEventsUnchecked,
      ));
  };
  const cacheTask = (task: RelayTask) => {
    const summary = taskSummaryFromTask(task);
    for (const [key] of taskLists()) {
      const first = key[TASKS_QUERY_KEY.length];
      const computerId = first === COMPUTER_TASKS_QUERY_KEY.at(-1) ? key[COMPUTER_TASKS_QUERY_KEY.length] : undefined;
      const projectId = computerId || isTaskListScope(first) ? undefined : first;
      const scope = computerId ? key[COMPUTER_TASKS_QUERY_KEY.length + 1]
        : projectId ? key[TASKS_QUERY_KEY.length + 1] : first;
      const bound = task.workspaceBinding?.computerId || task.computerId;
      const inWorkspace = computerId ? !task.projectId && (!bound || bound === computerId)
        : !projectId || projectId === task.projectId;
      const inScope = scope === "automations"
        ? task.isRoutine || (task.sourceRoutineId && ["assigned", "queued", "running", "waiting_for_human", "review"].includes(task.status))
        : scope === "board" ? !task.isRoutine && !task.sourceRoutineId : scope !== "issues" || !task.isRoutine;
      queryClient.setQueryData<RelayTaskSummary[]>(key, current => current && (
        inScope && inWorkspace
          ? mergeTaskSummaryIntoTasks(current, summary)
          : current.filter(row => row.id !== task.id)
      ));
    }
  };
  const cacheProject = (project: ProjectRecord) => {
    queryClient.setQueryData(projectRecordKey(project.id, project.version), { project });
    queryClient.setQueryData<ProjectListItem[]>(PROJECTS_QUERY_KEY, (current) =>
      current?.some(row => row.id === project.id && row.version > project.version)
        ? current : current && mergeProjectIntoProjects(current, projectDirectoryEntry(project)));
    queryClient.setQueryData<ProjectIndexRow[]>(PROJECT_INDEX_QUERY_KEY, (current) =>
      current?.some(row => row.id === project.id && row.version > project.version)
        ? current : current && mergeProjectIntoProjects(current, projectIndexRow(project)));
  };

  const onRelayError = (context: string, messageKey: string) => (error: unknown) => {
    reportMutationError(context, error, t(messageKey));
  };

  const renameSessionMutation = useMutation({
    mutationFn: ({ sessionId, title, token }: { sessionId: string; title: string } & TokenArg) =>
      renameSession(sessionId, title, token),
    onSuccess: (session) => {
      cacheSession(session);
      void invalidateWorkspaceActivity();
    },
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
      void queryClient.invalidateQueries({ queryKey: [TASK_RECORD_QUERY_KEY] });
      void invalidateWorkspaceActivity();
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
      void queryClient.invalidateQueries({ queryKey: THREAD_QUEUE_QUERY_KEY });
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

  const decideWorkflowMutation = useMutation({
    mutationFn: ({ sessionId, kind, binding, answer }: {
      sessionId: string;
      kind: "approve" | "reject" | "retry" | "cancel" | "answer";
      binding: WorkflowAttemptBinding;
      answer?: string;
    }) => decideWorkflow(sessionId, kind, binding, answer),
    onSuccess: (session) => {
      cacheSession(session);
      void invalidateThreadTasks(session.id);
      return invalidateTaskWorkflowSession(session.id);
    },
    onError: (error: unknown, { sessionId }) => {
      onRelayError("Failed to record workflow decision", "errors.workflow_decision")(error);
      // A stale or already-decided attempt: refetch so the slip shows the
      // current attempt instead of offering the old one again.
      if (error instanceof RelayApiError && error.status === 409) {
        void invalidateSessions();
        return invalidateTaskWorkflowSession(sessionId);
      }
    },
  });

  const answerPermissionMutation = useMutation({
    mutationFn: ({ sessionId, requestId, answer, token }: { sessionId: string; requestId: string; answer: PermissionAnswerInput } & TokenArg) =>
      answerPermissionRequest(sessionId, requestId, answer, token),
    onSuccess: (session) => cacheSession(session),
    onError: (error: unknown) => {
      // Someone answered first, or the run ended: the stream will drop the card.
      const messageKey = error instanceof RelayApiError && error.code === "permission_request_closed"
        ? "errors.permission_request_closed"
        : "errors.answer_permission";
      onRelayError("Failed to answer permission request", messageKey)(error);
    },
  });

  const threadPermissionModeMutation = useMutation({
    mutationFn: ({ sessionId, mode }: { sessionId: string; mode: ThreadPermissionMode }) =>
      setThreadPermissionMode(sessionId, mode),
    onSuccess: cacheSession,
    onError: onRelayError("Failed to set Thread permission mode", "errors.thread_permission_mode"),
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
      if (input.questionId) void invalidateThreadTasks(session.id);
    },
    onError: (error, { sessionId }) => {
      if (!(error instanceof RelayApiError)) return;
      // The question was answered or replaced elsewhere: fetch the one the
      // task waits on now, so the prompt stops offering the stale one.
      if (error.code === "question_superseded") void invalidateThreadTasks(sessionId);
      // A background task or another tab started a run before the composer
      // saw it. Refresh this thread so the next send can use its queue.
      if (error.code === "thread_run_active") {
        void fetchSessionSnapshot(queryClient, sessionId).then(cacheSession, () => undefined);
      }
    },
  });

  const requestThreadRecoveryMutation = useMutation({
    mutationFn: ({ sessionId, input }: { sessionId: string; input: ThreadRecoveryInput }) =>
      requestThreadRecovery(sessionId, input),
    onSuccess: (session) => {
      cacheSession(session);
      void invalidateNodes();
      void invalidateThreadTasks(session.id);
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: (input: CreateTaskInput) => createTask(input),
    onSuccess: async (task) => {
      // A list poll started before creation can still carry the old rows.
      // Cancel it before publishing the new task or automation, otherwise its
      // response removes the new record until another refresh.
      await queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY });
      cacheTask(task);
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY, predicate: query =>
        query.state.data === undefined
        || query.queryKey[TASKS_QUERY_KEY.length] === HOME_TASKS_QUERY_KEY[TASKS_QUERY_KEY.length]
        || query.queryKey[TASKS_QUERY_KEY.length] === ISSUES_PAGE_KEY[TASKS_QUERY_KEY.length]
        || (task.isRoutine && query.queryKey[TASKS_QUERY_KEY.length] === AUTOMATIONS_PAGE_KEY[TASKS_QUERY_KEY.length])
        || query.queryKey[TASKS_QUERY_KEY.length] === THREAD_TASKS_QUERY_KEY[TASKS_QUERY_KEY.length]
        || query.queryKey.at(-1) === "project-dashboard"
        || query.queryKey[TASKS_QUERY_KEY.length + 1] === "prerequisite-choices",
      });
    },
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
      // Keep the reviewed work visible until acceptance actually commits;
      // an optimistic done would unmount the brief before a stale refusal.
      if (input.reviewRevision) {
        await queryClient.cancelQueries({ queryKey: [TASK_RECORD_QUERY_KEY, taskId] });
        return;
      }
      const { status, priority, dueDate, assignedAgentId, assignedTeamId } = input;
      const assignmentChanged = assignedAgentId !== undefined || assignedTeamId !== undefined;
      if (!status && !priority && dueDate === undefined && !assignmentChanged) return;
      await queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY });
      return taskLists().flatMap(([key, rows]) => {
        const previous = rows.find(task => task.id === taskId);
        if (!previous) return [];
        const next = {
          ...previous,
          ...(status ? { status, workflowStage: status === "blocked" || status === "waiting_for_human" ? previous.workflowStage : status } : {}),
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
        const optimistic = queryClient.setQueryData<RelayTaskSummary[]>(key, current =>
          current?.map(row => row.id === taskId ? next : row))?.find(row => row.id === taskId);
        return [{ key, previous, optimistic }];
      });
    },
    onError: (error, { taskId }, context) => {
      for (const { key, previous, optimistic } of context ?? []) {
        // Only undo this write while it still owns the row. Another edit or
        // server response supersedes it; reconciliation settles that race.
        queryClient.setQueryData<RelayTaskSummary[]>(key, current =>
          current?.map(task => task.id === taskId && task === optimistic ? previous : task));
      }
      const key = error instanceof RelayApiError ? taskFlowErrorKey(error.code) : undefined;
      onRelayError("Failed to update task", key ?? "errors.save_task")(error);
    },
    // Settled, not success: a rolled-back failure must resync from the server
    // too, otherwise the board keeps showing the pre-mutation snapshot.
    onSuccess: (task, { input }) => {
      cacheTask(task);
      if (input.reviewRevision) queryClient.setQueryData([TASK_RECORD_QUERY_KEY, task.id], task);
    },
    onSettled: () => void invalidateTasks(),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: ({ taskId }: { taskId: string }) => deleteTask(taskId),
    onSuccess: (_result, { taskId }) => {
      filterTaskLists(task => task.id !== taskId);
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
        filterTaskLists(task => !removed.has(task.id));
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
    onSuccess: (task) => {
      cacheTask(task);
      invalidateTaskProjections(task);
    },
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
      invalidateTaskProjections(result.task);
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
    onSuccess: async ({ project }) => {
      const keys = [PROJECTS_QUERY_KEY, PROJECT_INDEX_QUERY_KEY];
      const cached = keys.filter(key => {
        const state = queryClient.getQueryState(key);
        return state?.data !== undefined && !state.isInvalidated;
      });
      await Promise.all(cached.map(queryKey => queryClient.cancelQueries({ queryKey, exact: true })));
      cacheProject(project);
      for (const queryKey of keys) {
        if (!cached.includes(queryKey)) void queryClient.invalidateQueries({ queryKey, exact: true });
      }
    },
    onError: onRelayError("Failed to create project", "errors.save_project"),
  });

  const startProjectSetupMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: StartProjectSetupInput }) =>
      startProjectSetup(projectId, input),
    onSuccess: ({ project }) => {
      cacheProject(project);
      void invalidateProjects();
      void invalidateTasks();
    },
    onError: onRelayError("Failed to start project setup", "errors.start_project_setup"),
  });

  // No shared error toast: the setup panel states the failure beside Apply,
  // and a retry creates only the tasks still missing.
  const applySetupTasksMutation = useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: ApplySetupTasksInput }) =>
      applySetupTasks(projectId, input),
    onSuccess: ({ project, tasks }) => {
      cacheProject(project);
      tasks.forEach(cacheTask);
      void invalidateTasks();
    },
  });

  const setTaskPrerequisitesMutation = useMutation({
    mutationFn: ({ taskId, prerequisiteTaskIds }: { taskId: string; prerequisiteTaskIds: string[] }) =>
      setTaskPrerequisites(taskId, prerequisiteTaskIds),
    onSuccess: (task) => {
      cacheTask(task);
      // A dependent's `unblocks` and every list row's `waitingOn` changed too.
      void invalidateTasks();
      void queryClient.invalidateQueries({ queryKey: [TASK_RECORD_QUERY_KEY] });
    },
    onError: onRelayError("Failed to save prerequisites", "errors.save_prerequisites"),
  });

  const updateProjectMutation = useMutation({
    mutationFn: ({ projectId, input, baseProject }: { projectId: string; input: UpdateProjectInput; baseProject?: ProjectRecord }) =>
      updateProject(projectId, input, baseProject),
    onSuccess: async ({ project }, { input, baseProject }) => {
      const change = input.memberChange;
      const editsMemberText = change?.op === "update"
        && input.leadAgentId === undefined
        && Object.keys(change.fields).every(field => field === "responsibilities" || field === "instructions");
      const directoryCached = Boolean(baseProject) && (
        queryClient.getQueryData(PROJECTS_QUERY_KEY) !== undefined || queryClient.getQueryData(PROJECT_INDEX_QUERY_KEY) !== undefined);
      if (directoryCached) await queryClient.cancelQueries({ queryKey: PROJECTS_QUERY_KEY });
      cacheProject(project);
      if (!directoryCached) void invalidateProjects();
      if (input.name !== undefined || input.enabled !== undefined) void invalidateTeamWorkflowChoices();
      if (!editsMemberText) void invalidateIssues();
    },
    onError: (error, { input }) => {
      // Project editors reconcile version conflicts and show a confirmation.
      // A generic failure toast here incorrectly blames the computer/roster.
      if (error instanceof RelayApiError && (error.code === "project_version_conflict"
        || (input.memberChange && error.status === 400 && error.code === "project_patch_unsupported"))) return;
      onRelayError("Failed to update project", "errors.save_project")(error);
    },
  });

  const archiveProjectMutation = useMutation({
    mutationFn: ({ projectId, expectedVersion }: { projectId: string; expectedVersion: number }) =>
      archiveProject(projectId, expectedVersion),
    onSuccess: ({ project }) => {
      cacheProject(project);
      void invalidateProjects();
      void invalidateTeamWorkflowChoices();
      void invalidateSessions();
      void invalidateTasks();
    },
    onError: onRelayError("Failed to archive project", "errors.archive_project"),
  });

  const unarchiveProjectMutation = useMutation({
    mutationFn: ({ projectId, expectedVersion }: { projectId: string; expectedVersion: number }) =>
      unarchiveProject(projectId, expectedVersion),
    onSuccess: ({ project }) => {
      cacheProject(project);
      void invalidateProjects();
      void invalidateTeamWorkflowChoices();
      void invalidateSessions();
      void invalidateTasks();
      announce({ message: t("project.unarchived"), tone: "success" });
    },
    onError: (error: unknown) => {
      if (error instanceof RelayApiError && error.code === "project_version_conflict") void invalidateProjects();
      const nameTaken = error instanceof RelayApiError && error.code === "project_name_taken";
      reportMutationError(
        "Failed to unarchive project",
        error,
        t(nameTaken ? "errors.unarchive_project_name_taken" : "errors.unarchive_project"),
      );
    },
  });

  const deleteProjectMutation = useMutation({
    /* `openThread` lets a refusal offer the thread that blocks it; it rides
       the variables because only the caller can navigate. */
    mutationFn: ({ projectId, expectedVersion }: {
      projectId: string;
      expectedVersion: number;
      openThread?: (sessionId: string) => void;
    }) => deleteProject(projectId, expectedVersion),
    onSuccess: async ({ deletedProjectId, workspaceCleanup, detachedTaskIds }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: PROJECTS_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: TASKS_QUERY_KEY }),
      ]);
      queryClient.setQueryData<ProjectListItem[]>(PROJECTS_QUERY_KEY, (current) =>
        current?.filter((project) => project.id !== deletedProjectId));
      queryClient.setQueryData<ProjectIndexRow[]>(PROJECT_INDEX_QUERY_KEY, (current) =>
        current?.filter((project) => project.id !== deletedProjectId));
      queryClient.setQueryData<RelaySession[]>(SESSIONS_QUERY_KEY, (current) =>
        current?.filter((session) => session.projectId !== deletedProjectId));
      filterTaskLists(task => task.projectId !== deletedProjectId);
      await Promise.all([invalidateProjects(), invalidateSessions(), invalidateTasks(), invalidateTeamWorkflowChoices()]);
      queryClient.removeQueries({ queryKey: [...PROJECT_RECORD_QUERY_KEY, deletedProjectId] });
      queryClient.removeQueries({ queryKey: [...PROJECT_DIRECTORY_ENTRY_QUERY_KEY, deletedProjectId] });
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
    onError: (error: unknown, { openThread }) => {
      // A stale version means the project changed underneath the dialog; load
      // the current one so the next attempt can succeed.
      if (error instanceof RelayApiError && error.code === "project_version_conflict") void invalidateProjects();
      const sessions = queryClient.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY) ?? [];
      const tasks = queryClient.getQueryData<RelayTaskSummary[]>(TASKS_QUERY_KEY) ?? [];
      const message = projectDeleteErrorMessage(
        error,
        (sessionId) => {
          const session = sessions.find((candidate) => candidate.id === sessionId);
          return session ? threadLabel(session) : undefined;
        },
        (taskId) => tasks.find((candidate) => candidate.id === taskId)?.title || undefined,
      );
      const blockingThreadId = projectDeleteBlockingThreadId(error);
      const action = blockingThreadId && openThread
        ? { label: t("project.delete_open_blocking_thread"), onClick: () => openThread(blockingThreadId) }
        : undefined;
      reportMutationError("Failed to delete project", error, t(message.key, message.values), action);
    },
  });

  const updateTeamMutation = useMutation({
    mutationFn: ({ teamId, input }: { teamId: string; input: Partial<TeamMutationInput> }) =>
      updateTeam(teamId, input),
    onSuccess: (data) => {
      if (data?.team) queryClient.setQueryData(teamRecordKey(data.team.ownerUserId, data.team.id), data);
      void invalidateTeams();
      void invalidateTasks();
    },
    onError: onRelayError("Failed to update team", "errors.save_team"),
  });

  const updateTeamMemberConfigMutation = useMutation({
    mutationFn: ({ team, agentId, fields }: { team: AgentTeam; agentId: string; fields: TeamMemberConfigPatch }) =>
      updateTeamMemberConfig(team, agentId, fields),
    onSuccess: async ({ team, baseVersion }, { agentId }) => {
      const recordKey = teamRecordKey(team.ownerUserId, team.id);
      const rosterKey = [TEAMS_QUERY_KEY, team.ownerUserId];
      await Promise.all([
        queryClient.cancelQueries({ queryKey: recordKey, exact: true }),
        queryClient.cancelQueries({ queryKey: rosterKey, exact: true }),
      ]);
      queryClient.setQueryData<{ team: AgentTeam }>(recordKey, current =>
        (current?.team.version ?? -1) > (team.version ?? -1) ? current : { team });
      const roster = queryClient.getQueryData<AgentTeamsResponse>(rosterKey);
      const previous = roster?.teams.find(row => row.id === team.id);
      if (baseVersion === undefined || team.version === undefined || !roster || !previous || previous.version === undefined) {
        void invalidateTeams();
        return;
      }
      if (previous.version >= team.version) return;
      if (previous.version !== baseVersion) {
        void invalidateTeams();
        return;
      }
      const { role, participation } = team.memberConfigs?.[agentId] ?? {};
      const row = roster.view === "summary" ? {
        ...previous, version: team.version, updatedAt: team.updatedAt,
        memberConfigs: {
          ...previous.memberConfigs,
          [agentId]: { ...(role ? { role } : {}), ...(participation ? { participation } : {}) },
        },
      } : team;
      queryClient.setQueryData<AgentTeamsResponse>(rosterKey, {
        ...roster, teams: roster.teams.map(item => item.id === row.id ? row : item),
      });
    },
    onError: onRelayError("Failed to update team member", "errors.save_team"),
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
    decideWorkflowMutation,
    answerPermissionMutation,
    threadPermissionModeMutation,
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
    applySetupTasksMutation,
    setTaskPrerequisitesMutation,
    updateProjectMutation,
    archiveProjectMutation,
    unarchiveProjectMutation,
    deleteProjectMutation,
    updateTeamMutation,
    updateTeamMemberConfigMutation,
    deleteTeamMutation,
  };
}
