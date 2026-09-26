"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useBacklogTaskForm } from "../hooks/useBacklogTaskForm";
import { useRecordDrawerMirror } from "../hooks/useRecordDrawerMirror";
import { useEmployeeAgents } from "../hooks/useEmployeeAgents";
import { useTeams } from "../hooks/useTeams";
import { useUrlFilters } from "../hooks/useUrlFilters";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { usePagination } from "../hooks/usePagination";
import { useListSort } from "../hooks/useListSort";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Pagination } from "@/components/ui/Pagination";
import { SortMenu } from "@/components/ui/SortMenu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { agentReadyForTask, filterTasks, isoToday } from "../lib/backlog";
import { applySort } from "../lib/listSort";
import { paginate } from "../lib/pagination";
import {
  DEFAULT_ISSUE_GROUPING,
  DEFAULT_ISSUE_QUEUE,
  ISSUE_GROUPINGS,
  groupIssues,
  issueNeedsProject,
  issueQueueCounts,
  issueSortColumns,
  issuesInQueue,
  parseIssueGroupBy,
  parseIssueQueue,
  type IssueGroupBy,
  type IssueGroupLabels,
} from "../lib/issueQueues";
import { emptyBacklogForm } from "../lib/taskBoardForm";
import { taskCreateIntent } from "../lib/taskCreateIntent";
import { taskAgentDisplayName, taskAssigneeLabel, teamReady } from "../lib/taskAssignment";
import { taskRef } from "../lib/taskRef";
import {
  EMPTY_TASK_SELECTION,
  pruneSelection,
  selectedTasks,
  selectionCheckState,
  toggleAllSelected,
  toggleSelected,
  type TaskSelection,
} from "../lib/taskSelection";
import { PageHeader } from "./PageHeader";
import { BoardEmpty } from "./BoardEmpty";
import { TaskBoardHeaderActions } from "./TaskBoardHeaderActions";
import { TaskDrawer } from "./task-board/TaskDrawer";
import { TaskRecordView } from "./task-record/TaskRecordView";
import { BacklogFiltersBar } from "./task-board/BacklogChrome";
import { TaskSelectAllCheckbox, TaskSelectionBar } from "./task-board/TaskSelection";
import { activeFilterCount, BACKLOG_FILTER_SPEC, initialFilters } from "./task-board/backlogVocabulary";
import { IssueQueueNav } from "./issues/IssueQueueNav";
import { IssuesTable, type IssueRowContext } from "./issues/IssuesTable";
import type { CurrentUser, DaemonNodeMonitorRecord, ProjectRecord, RelayTaskListItem } from "../types";

/** A table read across projects wants more rows per page than a board lane. */
const ISSUE_PAGE_SIZE = 50;

/**
 * Issues: every piece of work, across every project, as one table.
 *
 * A project's Tasks tab is where its work is planned and run; this page is
 * where it is found and triaged. So the rail is queues ("needs me",
 * "untriaged", "blocked"…) rather than a status board, the table groups by
 * project, status, or assignee, and the batch action that matters here —
 * moving intake into a project — sits beside delete.
 *
 * An issue can be filed with no project. It is intake: it takes no agent or
 * team and never runs (the server refuses both) until triage moves it into a
 * project. See lib/issueQueues and backend/relay/services/issue_triage.py.
 */
export function IssuesPage({
  projects,
  projectNotice,
  onCreateProject,
  recordTaskId,
  onOpenRecord,
  tasks,
  nodes,
  currentUser,
  isRefreshing = false,
  onRefresh,
  onOpenThread,
}: {
  projects: ProjectRecord[];
  projectNotice?: ReactNode;
  onCreateProject?: (onCreated: (id: string) => void) => void;
  /** The issue whose record is open, from `/issues/<id>`. */
  recordTaskId?: string | null;
  onOpenRecord: (taskId: string | null) => void;
  tasks: RelayTaskListItem[];
  nodes: DaemonNodeMonitorRecord[];
  currentUser: CurrentUser;
  isRefreshing?: boolean;
  onRefresh?: () => Promise<void>;
  onOpenThread: (sessionId: string, taskId?: string) => void;
}) {
  const { t } = useTranslation();
  const { announce, confirm } = useDialogs();
  const { updateTaskMutation, deleteTasksMutation } = useRelayMutations();
  const { agents: logicalAgents } = useEmployeeAgents(currentUser.employeeId);
  const { teams } = useTeams(currentUser.employeeId);

  // Every control is URL state, so a triage view is a link somebody can paste.
  const [filters, setFilters] = useUrlFilters(initialFilters, BACKLOG_FILTER_SPEC);
  const [queue, setQueue] = useUrlSearchState("queue", DEFAULT_ISSUE_QUEUE, parseIssueQueue,
    (value) => (value === DEFAULT_ISSUE_QUEUE ? null : value));
  const [groupBy, setGroupBy] = useUrlSearchState<IssueGroupBy>("group", DEFAULT_ISSUE_GROUPING, parseIssueGroupBy,
    (value) => (value === DEFAULT_ISSUE_GROUPING ? null : value));
  const [projectFilter, setProjectFilter] = useUrlSearchState<string | null>("project", null,
    (value) => value || null, (value) => value);
  const { page, setPage } = usePagination();

  const {
    form, setForm, open: drawerOpen, assignmentFocus, saving, deleting, projectChoice,
    openForm, editTask, release, requestClose, submit, remove,
  } = useBacklogTaskForm({ currentUser, allowIntake: true });
  const recordMirror = useRecordDrawerMirror(recordTaskId ?? null, recordTaskId ?? null);
  const drawerRecordId = recordMirror.record;
  const [selection, setSelection] = useState<TaskSelection>(EMPTY_TASK_SELECTION);
  const [batchBusy, setBatchBusy] = useState(false);

  const projectName = useMemo(() => {
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return (id: string) => names.get(id) ?? id;
  }, [projects]);
  const labels = useMemo<IssueGroupLabels>(() => ({
    project: projectName,
    assignee: (task) => taskAssigneeLabel(task, taskAgentDisplayName(task, logicalAgents, teams), t),
  }), [projectName, logicalAgents, teams, t]);
  const sortColumns = useMemo(() => issueSortColumns(labels), [labels]);
  const { sort, toggleSort, setSort } = useListSort(sortColumns);

  /* Archived projects are closed rooms; their work leaves the global view
     unless someone asks for that project by name. */
  const issues = useMemo(() => {
    const archived = new Set(projects.filter((project) => project.archivedAt).map((project) => project.id));
    return tasks.filter((task) => !task.deletedAt && !task.isRoutine
      && (!task.projectId || !archived.has(task.projectId) || task.projectId === projectFilter));
  }, [tasks, projects, projectFilter]);
  const queueContext = useMemo(
    () => ({ employeeId: currentUser.employeeId ?? "", today: isoToday() }),
    [currentUser.employeeId],
  );
  const scoped = useMemo(() => filterTasks(issues, { ...filters, status: "all" })
    .filter((task) => !projectFilter || task.projectId === projectFilter), [issues, filters, projectFilter]);
  const counts = useMemo(() => issueQueueCounts(scoped, queueContext), [scoped, queueContext]);
  const visible = useMemo(
    () => applySort(issuesInQueue(scoped, queue, queueContext), sortColumns, sort),
    [scoped, queue, queueContext, sortColumns, sort],
  );
  const listPage = useMemo(() => paginate(visible, page, ISSUE_PAGE_SIZE), [visible, page]);
  const groups = useMemo(() => groupIssues(listPage.items, groupBy, labels), [listPage.items, groupBy, labels]);
  const groupTotals = useMemo(
    () => new Map(groupIssues(visible, groupBy, labels).map((group) => [group.key, group.tasks.length])),
    [visible, groupBy, labels],
  );
  const visibleIds = useMemo(() => listPage.items.map((task) => task.id), [listPage.items]);
  const visibleSelection = useMemo(() => pruneSelection(selection, visibleIds), [selection, visibleIds]);
  const selected = useMemo(() => selectedTasks(visible, visibleSelection), [visible, visibleSelection]);
  const movable = selected.filter((task) => issueNeedsProject(task) && task.status !== "done");
  const openProjects = projects.filter((project) => project.enabled && !project.archivedAt);

  const openCreate = () => openForm({ ...emptyBacklogForm(currentUser), projectId: projectFilter ?? undefined });

  // The `c` chord and the palette's "New issue" land here, as on the old board.
  useEffect(() => {
    const channel = taskCreateIntent();
    if (!channel) return;
    const consume = () => { if (channel.consume()) openCreate(); };
    consume();
    return channel.subscribe(consume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function rowContext(task: RelayTaskListItem): IssueRowContext {
    const team = teams.find((candidate) => candidate.id === task.assignedTeamId);
    return {
      projectName: task.projectId ? projectName(task.projectId) : undefined,
      ready: team ? teamReady(team) : agentReadyForTask(task, nodes, logicalAgents),
      agentDisplayName: team?.name ?? taskAgentDisplayName(task, logicalAgents, teams),
      agentImageUrl: team
        ? team.profileImageUrl
        : logicalAgents.find((agent) => agent.id === task.assignedAgentId)?.profileImageUrl,
    };
  }

  function dropFromSelection(ids: readonly string[]): void {
    setSelection((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  async function moveSelected(projectId: string): Promise<void> {
    if (!movable.length || batchBusy) return;
    setBatchBusy(true);
    const results = await Promise.allSettled(movable.map((task) =>
      updateTaskMutation.mutateAsync({ taskId: task.id, input: { projectId } })));
    const moved = movable.filter((_, index) => results[index].status === "fulfilled").map((task) => task.id);
    dropFromSelection(moved);
    setBatchBusy(false);
    if (moved.length) {
      announce({ message: t("issues.toast_moved", { count: moved.length, project: projectName(projectId) }), tone: "success" });
    }
  }

  async function deleteSelected(): Promise<void> {
    if (!selected.length || batchBusy) return;
    const confirmed = await confirm({
      title: t("backlog.bulk_delete_title", { count: selected.length }),
      message: t("backlog.bulk_delete_body", { count: selected.length }),
      confirmLabel: t("backlog.delete_selected"),
      cancelLabel: t("dialog.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;
    setBatchBusy(true);
    try {
      const { succeeded } = await deleteTasksMutation.mutateAsync({ taskIds: selected.map((task) => task.id) });
      dropFromSelection(succeeded);
      if (succeeded.length) announce({ message: t("backlog.toast_bulk_deleted", { count: succeeded.length }), tone: "success" });
    } catch {
      // The mutation's onError toasts; the selection stays for a retry.
    } finally {
      setBatchBusy(false);
    }
  }

  const filtered = activeFilterCount({ ...filters, status: "all" }) > 0
    || filters.query.trim().length > 0
    || Boolean(projectFilter);
  const projectField = {
    field: {
      id: "project",
      label: t("project.projects"),
      kind: "select" as const,
      options: projects.filter((project) => !project.archivedAt || project.id === projectFilter)
        .map((project) => ({ value: project.id, label: project.name })),
    },
    value: projectFilter ?? "",
    onChange: (id: string) => { setProjectFilter(id || null); setPage(1); },
  };
  const creatable = queue === "open" || queue === "untriaged";

  return (
    <section id="backlog-panel" className="backlog-page issues-page sec-shell" aria-label={t("issues.title")} tabIndex={-1}>
      <div className="sec-rail">
        <PageHeader kicker={t("nav.workspace")} title={t("issues.title")}
          count={t("issues.sub", { count: issues.length })} titleVariant="display" layout="stacked" />
        <IssueQueueNav value={queue} counts={counts} onChange={(next) => { setQueue(next); setPage(1); }} />
      </div>
      <div className="sec-main">
        <PageHeader
          title={t(`issues.queues.${queue}`)}
          subtitle={t(`issues.queue_hints.${queue}`)}
          titleAs="h2"
          titleVariant="display"
          actions={(
            <TaskBoardHeaderActions
              refreshLabel={t("nav.refresh")}
              createLabel={t("issues.new_issue")}
              isRefreshing={isRefreshing}
              onRefresh={onRefresh ? () => void onRefresh() : undefined}
              onCreate={openCreate}
            />
          )}
        />
        {projectNotice}
        <BacklogFiltersBar
          filters={filters}
          extraField={projectField}
          agents={logicalAgents}
          teams={teams}
          onChange={(next) => { setFilters(next); setPage(1); }}
          sortMenu={(
            <>
              <Select value={groupBy} onValueChange={(value) => { if (value) setGroupBy(parseIssueGroupBy(value)); }}>
                <SelectTrigger className="issues-group-by" aria-label={t("issues.group_by")}>
                  <SelectValue>{(value: IssueGroupBy) => t("issues.group_by_value", { value: t(`issues.groupings.${value}`) })}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_GROUPINGS.map((value) => (
                    <SelectItem key={value} value={value}>{t(`issues.groupings.${value}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <SortMenu
                options={[
                  { key: "title", label: t("issues.col_issue") },
                  { key: "status", label: t("backlog.status") },
                  { key: "project", label: t("issues.col_project") },
                  { key: "priority", label: t("backlog.priority") },
                  { key: "assignee", label: t("backlog.assignee") },
                  { key: "due", label: t("backlog.due") },
                  { key: "updated", label: t("issues.col_updated"), defaultDirection: "desc" },
                ]}
                sort={sort}
                onSortChange={setSort}
                label={t("backlog.sort_label")}
              />
            </>
          )}
        />

        {visible.length === 0 ? (
          <BoardEmpty
            title={filtered ? t("backlog.no_match_title") : t(`issues.empty.${queue}`)}
            body={filtered ? t("backlog.no_match_body") : t("issues.empty_body")}
            createLabel={filtered || !creatable ? undefined : t("issues.new_issue")}
            onCreate={filtered || !creatable ? undefined : openCreate}
            clearLabel={filtered ? t("backlog.clear_filters") : undefined}
            onClear={filtered ? () => { setFilters(initialFilters); setProjectFilter(null); } : undefined}
          />
        ) : (
          <div className="backlog-rows issues-rows" data-density="compact">
            <IssuesTable
              groups={groups}
              groupBy={groupBy}
              groupTotals={groupTotals}
              sort={sort}
              onSort={toggleSort}
              selectAll={(
                <TaskSelectAllCheckbox
                  state={selectionCheckState(visibleSelection, visibleIds)}
                  label={t("issues.select_all")}
                  onToggle={() => setSelection((current) => toggleAllSelected(current, visibleIds))}
                />
              )}
              selectedIds={visibleSelection}
              onToggleSelect={(taskId) => setSelection((current) => toggleSelected(current, taskId))}
              contextFor={rowContext}
              onOpenIssue={onOpenRecord}
            />
            <Pagination page={listPage} onPageChange={setPage} label={t("issues.title")} />
          </div>
        )}

        <TaskSelectionBar
          count={visibleSelection.size}
          deleting={batchBusy}
          deleteLabel={t("backlog.delete_selected")}
          onDelete={() => { void deleteSelected(); }}
          onClear={() => setSelection(EMPTY_TASK_SELECTION)}
          actions={movable.length ? (
            <Select value="" onValueChange={(value) => { if (value) void moveSelected(value); }}>
              <SelectTrigger className="issues-move" aria-label={t("issues.move_to_project")} disabled={batchBusy || !openProjects.length}>
                <SelectValue>{() => t("issues.move_count", { count: movable.length })}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {openProjects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
        />
      </div>

      {drawerRecordId ? (
        <TaskRecordView
          taskId={drawerRecordId}
          currentUser={currentUser}
          tasks={tasks}
          drawer={{ open: Boolean(recordTaskId), onClose: () => onOpenRecord(null), onClosed: recordMirror.release }}
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
          projectChoice={projectChoice}
          logicalAgents={logicalAgents}
          projects={projects}
          onCreateProject={onCreateProject
            ? () => onCreateProject((id) => setForm((current) => (current ? { ...current, projectId: id } : current)))
            : undefined}
          teams={teams}
          saving={saving}
          deleting={deleting}
          initialFocus={assignmentFocus ? "assignment" : "title"}
          title={form.id ? t("issues.edit_issue") : t("issues.new_issue")}
          subtitle={form.id ? `${t("backlog.col_ref")} ${taskRef(form.id)}` : t("backlog.new_task_id")}
          onClose={() => { void requestClose(); }}
          onClosed={release}
          onChange={(next) => { if (next.variant === "backlog") setForm(next); }}
          onSubmit={(event) => void submit(event)}
          onDelete={form.id ? () => { void remove(); } : undefined}
          layer={drawerRecordId ? 1 : 0}
        />
      ) : null}
    </section>
  );
}
