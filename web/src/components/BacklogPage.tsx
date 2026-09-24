"use client";


import { TASK_FLOW_STAGES, type TaskWorkflowStage } from "../lib/taskFlow";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useBacklogTaskForm } from "../hooks/useBacklogTaskForm";
import { useRecordDrawerMirror } from "../hooks/useRecordDrawerMirror";
import { useEmployeeAgents } from "../hooks/useEmployeeAgents";
import { useTeams } from "../hooks/useTeams";
import { useDialogs } from "@/components/ui/DialogProvider";
import { TASK_STATUSES, agentReadyForTask, backlogSortColumns, filterTasks, tasksByStatus } from "../lib/backlog";
import { applySort } from "../lib/listSort";
import { LANE_PAGE_SIZE, paginate } from "../lib/pagination";
import { useLanePagination, usePagination } from "../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { useListSort } from "../hooks/useListSort";
import { SortMenu } from "@/components/ui/SortMenu";
import { taskDropRejection } from "../lib/taskDrag";
import { emptyBacklogForm, taskStartMutationInput } from "../lib/taskBoardForm";
import { TaskDrawer } from "./task-board/TaskDrawer";
import { TaskRecordView } from "./task-record/TaskRecordView";
import { taskCreateIntent } from "../lib/taskCreateIntent";
import { PageHeader } from "./PageHeader";
import { BoardEmpty } from "./BoardEmpty";
import { TaskBoardHeaderActions } from "./TaskBoardHeaderActions";
import { taskAgentDisplayName, taskAssigneeLabel, teamReady } from "../lib/taskAssignment";
import { type ProjectRecord, type CurrentUser, type DaemonNodeMonitorRecord, type RelaySession, type RelayTaskListItem, type TaskStatus } from "../types";
import { useUrlFilters } from "../hooks/useUrlFilters";
import { writeViewPreference } from "../lib/viewPreference";
import { taskRef } from "../lib/taskRef";


interface BacklogPageProps {
  projectId?: string;
  projectNotice?: ReactNode;
  onSelectProject?: (id: string | null) => void;
  projects?: ProjectRecord[];
  onCreateProject?: (onCreated: (id: string) => void) => void;
  /** The task whose record is open, from `/backlog/<id>`. */
  recordTaskId?: string | null;
  /** Opens a record; `null` returns to the board. */
  onOpenRecord: (taskId: string | null) => void;
  tasks: RelayTaskListItem[];
  sessions: RelaySession[];
  nodes: DaemonNodeMonitorRecord[];
  currentUser: CurrentUser;
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
  onOpenThread: (sessionId: string, taskId?: string) => void;
}

import {
  activeFilterCount,
  BACKLOG_FILTER_SPEC,
  VIEW_STORAGE_KEY,
  initialFilters,
  parseBacklogView,
  type BacklogView,
} from "./task-board/backlogVocabulary";
import { TaskStatusNav, BacklogStats, BacklogFiltersBar, BacklogViewToggle } from "./task-board/BacklogChrome";
import { BacklogTaskList } from "./task-board/BacklogRecords";
import { BacklogBoard } from "./task-board/BacklogBoard";
import { TaskSelectAllCheckbox, TaskSelectionBar } from "./task-board/TaskSelection";
import {
  EMPTY_TASK_SELECTION,
  pruneSelection,
  selectedTasks,
  selectionCheckState,
  toggleAllSelected,
  toggleSelected,
  type TaskSelection,
} from "../lib/taskSelection";






export function BacklogPage({ projectId, projectNotice, onSelectProject, projects = [], onCreateProject, recordTaskId, onOpenRecord, tasks, sessions, nodes, currentUser, isRefreshing, onRefresh, onOpenThread }: BacklogPageProps) {
  const { agents: logicalAgents } = useEmployeeAgents(currentUser.employeeId);
  const { teams } = useTeams(currentUser.employeeId);
  const { t } = useTranslation();
  const { announce, confirm } = useDialogs();
  const {
    startTaskMutation,
    updateTaskMutation,
    deleteTaskMutation,
    deleteTasksMutation,
  } = useRelayMutations();
  // The filters live in the query string, so a filtered board survives
  // opening a record and coming back, and it is a link somebody can paste.
  const [filters, setFilters] = useUrlFilters(initialFilters, BACKLOG_FILTER_SPEC);
  const [view, setView] = useState<BacklogView>("list");
  /* The form is a shared controller, not this board's own: the project board
     opens the same record drawer and edits through the same form. */
  const {
    form,
    setForm,
    open: drawerOpen,
    assignmentFocus,
    saving,
    deleting,
    openForm: openTaskForm,
    editTask,

    release: releaseTaskForm,
    requestClose: closeTaskForm,
    submit: submitTask,
    remove: deleteBacklog,
  } = useBacklogTaskForm({ currentUser, seed: { projectId } });
  const [selection, setSelection] = useState<TaskSelection>(EMPTY_TASK_SELECTION);
  const [deletingSelection, setDeletingSelection] = useState(false);
  // Retain the execution record until the drawer has finished closing.
  const recordMirror = useRecordDrawerMirror(recordTaskId ?? null, recordTaskId ?? null);
  const drawerRecordId = recordMirror.record;
  const backlogTasks = useMemo(() => tasks.filter((task) => !task.isRoutine), [tasks]);

  /* Sort is applied AFTER filtering, over the one list both views read — the
     board keeps its lanes and reorders WITHIN them, which is the only degree
     of freedom a grouped view has. With no column chosen `applySort` is the
     identity, so the considered default order `filterTasks` produces
     (priority, then due date, then recency) survives untouched until the
     reader asks for something else. */
  const sortColumns = useMemo(
    () => backlogSortColumns((task) => taskAssigneeLabel(task, taskAgentDisplayName(task, logicalAgents, teams), t)),
    [logicalAgents, teams, t],
  );
  const { sort, toggleSort, setSort } = useListSort(sortColumns);
  const { lanePages, setLanePage } = useLanePagination(TASK_FLOW_STAGES);
  const filteredTasks = useMemo(
    () => applySort(filterTasks(backlogTasks, { ...filters, status: "all" })
      .filter((task) => filters.status === "all" || task.status === filters.status), sortColumns, sort),
    [backlogTasks, filters, sort, sortColumns],
  );
  const grouped = useMemo(() => tasksByStatus(filteredTasks), [filteredTasks]);
  const hasFilterResults = filteredTasks.length > 0;
  const showEmptyBoard = backlogTasks.length === 0 || !hasFilterResults;
  // Board pagination stays independent for each status lane.
  const pagedLanes = useMemo(
    () => Object.fromEntries(TASK_FLOW_STAGES.map((status) => [
      status,
      paginate(grouped[status], lanePages[status] ?? 1, LANE_PAGE_SIZE),
    ])) as Record<TaskStatus, ReturnType<typeof paginate<RelayTaskListItem>>>,
    [grouped, lanePages],
  );
  /* Selection follows what is on screen in both views, so "select all" then
     Delete cannot reach a card or row on a lane page the reader never saw. */
  const sectionCounts = useMemo(() => {
    const scope = filterTasks(backlogTasks, { ...filters, status: "all" });
    return Object.fromEntries(TASK_STATUSES.map((status) => [
      status, scope.filter((task) => task.status === status).length,
    ])) as Record<TaskStatus, number>;
  }, [backlogTasks, filters]);
  const { page, setPage } = usePagination();
  const listPage = useMemo(() => paginate(filteredTasks, page), [filteredTasks, page]);
  const visibleTasks = view === "list" ? listPage.items : TASK_FLOW_STAGES.flatMap((status) => pagedLanes[status].items);
  const visibleIds = useMemo(() => visibleTasks.map((task) => task.id), [visibleTasks]);
  // Derived, not stored: a task hidden by a filter (or deleted elsewhere) drops
  // out of the selection immediately, so a batch action can never reach a
  // record the board is no longer showing.
  const visibleSelection = useMemo(() => pruneSelection(selection, visibleIds), [selection, visibleIds]);
  const selectedCount = visibleSelection.size;

  /* The project is a chip in the bar like any other filter, but choosing one
     navigates: a project's backlog is its own route, not a query param. */
  const projectFilter = useMemo(() => onSelectProject ? {
    field: {
      id: "project",
      label: t("project.projects"),
      kind: "select" as const,
      options: projects.filter((project) => !project.archivedAt || project.id === projectId)
        .map((project) => ({ value: project.id, label: project.name })),
    },
    value: projectId ?? "",
    onChange: (id: string) => onSelectProject(id || null),
  } : undefined, [onSelectProject, projects, projectId, t]);

  // Keep the server and first client render deterministic, then restore the
  // browser-only preference once hydration has completed.
  useEffect(() => {
    setView(parseBacklogView(null));
  }, []);

  // The `c` chord and the palette's "New task" land here: the event path
  // covers an already-mounted board, the one-shot flag covers the navigation
  // that mounts it. The form requires a project before creating.
  useEffect(() => {
    const channel = taskCreateIntent();
    if (!channel) return;
    const openInlineCreate = () => {
      if (channel.consume()) openTaskForm(emptyBacklogForm(currentUser));
    };
    openInlineCreate();
    return channel.subscribe(openInlineCreate);
  }, []);

  async function deleteSelectedTasks() {
    const targets = selectedTasks(filteredTasks, visibleSelection);
    if (targets.length === 0 || deletingSelection) return;
    const confirmed = await confirm({
      title: t("backlog.bulk_delete_title", { count: targets.length }),
      message: t("backlog.bulk_delete_body", { count: targets.length }),
      confirmLabel: t("backlog.delete_selected"),
      cancelLabel: t("dialog.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;
    setDeletingSelection(true);
    try {
      const { succeeded } = await deleteTasksMutation.mutateAsync({ taskIds: targets.map((task) => task.id) });
      // Only the records that actually went are dropped from the selection —
      // whatever refused stays checked so a retry needs no re-picking.
      setSelection((current) => {
        const next = new Set(current);
        for (const id of succeeded) next.delete(id);
        return next;
      });
      if (succeeded.length > 0) {
        announce({ message: t("backlog.toast_bulk_deleted", { count: succeeded.length }), tone: "success" });
      }
    } catch {
      // mutation onError surfaces a toast; the selection stays put for a retry.
    } finally {
      setDeletingSelection(false);
    }
  }



  function taskAssignmentDisplay(task: RelayTaskListItem): { name?: string; imageUrl?: string | null; ready: boolean } {
    const team = teams.find((candidate) => candidate.id === task.assignedTeamId);
    if (team) {
      return {
        name: team.name,
        imageUrl: team.profileImageUrl,
        ready: teamReady(team),
      };
    }
    return {
      name: taskAgentDisplayName(task, logicalAgents, teams),
      imageUrl: task.assignedTeamId ? undefined : logicalAgents.find((agent) => agent.id === task.assignedAgentId)?.profileImageUrl,
      ready: agentReadyForTask(task, nodes, logicalAgents),
    };
  }

  function changeView(next: BacklogView) {
    setView(next);
    writeViewPreference(VIEW_STORAGE_KEY, next);
  }

  // The single commit path for a board drop — mouse, touch and keyboard all
  // arrive here through the kanban's onMove.
  function moveTaskToLane(task: RelayTaskListItem, status: TaskStatus) {
    const rejection = taskDropRejection(task, status);
    if (rejection === "needs_assignment") {
      announce({ message: t("backlog.drop_needs_assignment"), tone: "error" });
      return;
    }
    if (rejection) return;
    if (status === "running") {
      startTaskMutation.mutate(taskStartMutationInput(task));
      return;
    }
    updateTaskMutation.mutate({ taskId: task.id, input: { status } }, {
      onSuccess: () => announce({
        message: t("backlog.drop_moved", { title: task.title, status: t(`backlog.statuses.${status}`) }),
        tone: "success",
      }),
    });
  }

  return (
    <section id="backlog-panel" className="backlog-page sec-shell" data-view={view} aria-label={t("backlog.title")} tabIndex={-1}>
      <div className="sec-rail">
        <PageHeader kicker={t("nav.workspace")} title={t("nav.backlog")}
          count={t("backlog.sub", { count: backlogTasks.length })} titleVariant="display" layout="stacked" />
        <TaskStatusNav value={filters.status} counts={sectionCounts}
          onChange={(status) => setFilters({ ...filters, status })} />
      </div>
      <div className="sec-main">
      <PageHeader
        title={filters.status === "all" ? t("backlog.title") : t(`backlog.statuses.${filters.status}`)}
        titleAs="h2"
        titleVariant="display"
        actions={
          <TaskBoardHeaderActions
            leading={<BacklogViewToggle view={view} onChange={changeView} />}
            refreshLabel={t("nav.refresh")}
            createLabel={t("backlog.new_task")}
            isRefreshing={isRefreshing}
            onRefresh={() => void onRefresh()}
            onCreate={() => openTaskForm(emptyBacklogForm(currentUser))}
          />
        }
      />

      {projectNotice}

      {onSelectProject || backlogTasks.length > 0 ? (
        <>
          {view === "board" ? <BacklogStats tasks={backlogTasks} /> : null}
          <BacklogFiltersBar
            filters={filters}
            extraField={projectFilter}
            agents={logicalAgents}
            teams={teams}
            onChange={setFilters}
            sortMenu={
              <SortMenu
                /* Status belongs to the section navigation. */
                options={[
                  { key: "title", label: t("backlog.col_task") },
                  { key: "priority", label: t("backlog.priority") },
                  { key: "assignee", label: t("backlog.assignee") },
                  { key: "due", label: t("backlog.due") },
                ]}
                sort={sort}
                onSortChange={setSort}
                label={t("backlog.sort_label")}
              />
            }
          />
        </>
      ) : null}

      {showEmptyBoard ? (
        (() => {
          const filtered = activeFilterCount({ ...filters, status: "all" }) > 0 || filters.query.trim().length > 0;
          return (
            <BoardEmpty
              title={filtered ? t("backlog.no_match_title") : t("backlog.no_tasks_title")}
              body={filtered ? t("backlog.no_match_body") : t("backlog.no_tasks_body")}
              createLabel={filtered ? undefined : t("backlog.new_task")}
              onCreate={filtered ? undefined : () => openTaskForm(emptyBacklogForm(currentUser))}
              clearLabel={filtered ? t("backlog.clear_filters") : undefined}
              onClear={filtered ? () => setFilters({ ...initialFilters, status: filters.status }) : undefined}
            />
          );
        })()
      ) : view === "list" ? (
        /* The sidebar owns status; the content stays one flat, sorted list. */
        <div className="backlog-rows" data-density="compact">
          <BacklogTaskList
            tasks={listPage.items}
            sort={sort}
            onSort={toggleSort}
            selectAll={
              <TaskSelectAllCheckbox
                state={selectionCheckState(visibleSelection, visibleIds)}
                label={t("backlog.select_all_tasks")}
                onToggle={() => setSelection((current) => toggleAllSelected(current, visibleIds))}
              />
            }
            selectedIds={visibleSelection}
            onToggleSelect={(taskId) => setSelection((current) => toggleSelected(current, taskId))}
            contextFor={(task) => {
              const assignment = taskAssignmentDisplay(task);
              return {
                projectName: projects.find((project) => project.id === task.projectId)?.name,
                ready: assignment.ready,
                agentDisplayName: assignment.name,
                agentImageUrl: assignment.imageUrl,
              };
            }}
            onOpenTask={onOpenRecord}
          />
          <Pagination page={listPage} onPageChange={setPage} label={t("backlog.title")} />
        </div>
      ) : (
        <BacklogBoard
          lanes={pagedLanes}
          laneTotals={Object.fromEntries(TASK_FLOW_STAGES.map((status) => [status, grouped[status].length])) as Record<TaskWorkflowStage, number>}
          cardProps={(task) => {
            const assignment = taskAssignmentDisplay(task);
            return {
              task,
              projectName: projects.find((project) => project.id === task.projectId)?.name,
              selected: visibleSelection.has(task.id),
              onToggleSelect: () => setSelection((current) => toggleSelected(current, task.id)),
              agentDisplayName: assignment.name,
              agentImageUrl: assignment.imageUrl,
              ready: assignment.ready,
              onOpen: () => onOpenRecord(task.id),
            };
          }}
          onMoveTask={moveTaskToLane}
          onCreateInLane={(status) => openTaskForm({ ...emptyBacklogForm(currentUser), status })}
          onLanePageChange={setLanePage}
        />
      )}

      <TaskSelectionBar
        count={selectedCount}
        deleting={deletingSelection}
        deleteLabel={t("backlog.delete_selected")}
        onDelete={() => { void deleteSelectedTasks(); }}
        onClear={() => setSelection(EMPTY_TASK_SELECTION)}
      />

      </div>

      {/* Execution opens over the list; editing uses a second drawer layer. */}
      {drawerRecordId ? (
        <TaskRecordView
          taskId={drawerRecordId}
          currentUser={currentUser}
          tasks={tasks}
          drawer={{
            open: Boolean(recordTaskId),
            onClose: () => onOpenRecord(null),
            onClosed: recordMirror.release,
          }}
          onEdit={editTask}
          onOpenThread={(sessionId) => onOpenThread(sessionId, drawerRecordId)}
          onOpenRecord={(nextId) => onOpenRecord(nextId)}
          onDeleted={() => onOpenRecord(null)}
        />
      ) : null}

      {form ? (
        <TaskDrawer
          open={drawerOpen}
          form={form}
          logicalAgents={logicalAgents}
          projects={projects}
          onCreateProject={onCreateProject ? () => onCreateProject((id) => setForm((current) => current ? { ...current, projectId: id } : current)) : undefined}
          teams={teams}
          saving={saving}
          deleting={deleting}
          initialFocus={assignmentFocus ? "assignment" : "title"}
          title={form.id ? t("backlog.edit_task") : t("backlog.new_task")}
          subtitle={form.id ? `${t("backlog.col_ref")} ${taskRef(form.id)}` : t("backlog.new_task_id")}
          onClose={() => { void closeTaskForm(); }}
          onClosed={releaseTaskForm}
          onChange={(next) => {
            if (next.variant === "backlog") setForm(next);
          }}
          onSubmit={(event) => void submitTask(event)}
          onDelete={form.id ? () => { void deleteBacklog(); } : undefined}
          layer={drawerRecordId ? 1 : 0}
        />
      ) : null}
    </section>
  );
}
