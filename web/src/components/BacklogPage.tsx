"use client";


import { TASK_FLOW_STAGES } from "../lib/taskFlow";

import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useBacklogTaskForm } from "../hooks/useBacklogTaskForm";
import { useRecordDrawerMirror } from "../hooks/useRecordDrawerMirror";
import { useEmployeeAgents } from "../hooks/useEmployeeAgents";
import { useTeams } from "../hooks/useTeams";
import { useDialogs } from "@/components/ui/DialogProvider";
import {
  ActionAdd,
  ICON,
} from "./icons";
import { TASK_STATUSES, agentReadyForTask, backlogSortColumns, canDiscussTask, discussionAgentsForTask, filterTasks, isTaskStatus, tasksByStatus } from "../lib/backlog";
import { applySort } from "../lib/listSort";
import { LANE_PAGE_SIZE, paginate } from "../lib/pagination";
import { useLanePagination, usePagination } from "../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { useListSort } from "../hooks/useListSort";
import { SortMenu } from "@/components/ui/SortMenu";
import { readDraggedTaskId, TASK_DRAG_MEDIA_TYPE, taskDropRejection } from "../lib/taskDrag";
import { emptyBacklogForm, taskStartMutationInput } from "../lib/taskBoardForm";
import { TaskDrawer } from "./task-board/TaskDrawer";
import { TaskRecordView } from "./task-record/TaskRecordView";
import { taskCreateIntent } from "../lib/taskCreateIntent";
import { PageHeader } from "./PageHeader";
import { BoardEmpty } from "./BoardEmpty";
import { TaskBoardHeaderActions } from "./TaskBoardHeaderActions";
import { taskAgentDisplayName, taskAssigneeLabel, teamReady } from "../lib/taskAssignment";
import { type ProjectRecord, type CurrentUser, type DaemonNodeMonitorRecord, type RelaySession, type RelayTaskListItem, type TaskStatus } from "../types";
import { useEdgeAutoScroll } from "../hooks/useEdgeAutoScroll";
import { useUrlFilters } from "../hooks/useUrlFilters";
import { useTouchTaskDrag } from "../hooks/useTouchTaskDrag";
import { laneStatusAtPoint, type DragPoint } from "../lib/touchDrag";
import { writeViewPreference } from "../lib/viewPreference";
import { Button } from "@/components/ui/button";
import { FilterSelect } from "./FiltersBar";
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
  onOpenThread: (sessionId: string) => void;
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
import { BacklogRowsHead, BacklogTaskCard, BacklogTaskRow } from "./task-board/BacklogRecords";
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
import { Table } from "@/components/ui/table";





// Half the drag chip's max width. The chip is centred on the finger and sits
// above it, so its centre has to stay this far from either screen edge — the
// right edge is exactly where a drag lingers to auto-scroll the board.
const DRAG_GHOST_HALF_WIDTH_PX = 104;

function dragGhostStyle(point: DragPoint): CSSProperties {
  const rightLimit = typeof window === "undefined"
    ? point.x
    : Math.max(window.innerWidth - DRAG_GHOST_HALF_WIDTH_PX, DRAG_GHOST_HALF_WIDTH_PX);
  const x = Math.min(Math.max(point.x, DRAG_GHOST_HALF_WIDTH_PX), rightLimit);
  return { transform: `translate3d(calc(${x}px - 50%), calc(${point.y}px - 220%), 0)` };
}


export function BacklogPage({ projectId, projectNotice, onSelectProject, projects = [], onCreateProject, recordTaskId, onOpenRecord, tasks, sessions, nodes, currentUser, isRefreshing, onRefresh, onOpenThread }: BacklogPageProps) {
  const { agents: logicalAgents } = useEmployeeAgents(currentUser.employeeId);
  const { teams } = useTeams(currentUser.employeeId);
  const { t } = useTranslation();
  const { announce, confirm, prompt } = useDialogs();
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
    assignTask,
    release: releaseTaskForm,
    requestClose: closeTaskForm,
    submit: submitTask,
    remove: deleteBacklog,
  } = useBacklogTaskForm({ currentUser, seed: { projectId } });
  const [selection, setSelection] = useState<TaskSelection>(EMPTY_TASK_SELECTION);
  const [deletingSelection, setDeletingSelection] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropLane, setDropLane] = useState<TaskStatus | null>(null);
  // Retain the execution record until the drawer has finished closing.
  const recordMirror = useRecordDrawerMirror(recordTaskId ?? null, recordTaskId ?? null);
  const drawerRecordId = recordMirror.record;
  const { track: trackBoardEdge, stop: stopBoardScroll } = useEdgeAutoScroll();
  const boardRef = useRef<HTMLDivElement | null>(null);
  const startInFlight = useRef<string | null>(null);
  const touchDrag = useTouchTaskDrag({
    onStart: (taskId) => setDraggedTaskId(taskId),
    onMove: (point) => {
      if (boardRef.current) trackBoardEdge(boardRef.current, point.x);
      const status = laneStatusAtPoint(document, point);
      setDropLane(isTaskStatus(status) ? status : null);
    },
    onDrop: () => {
      moveTaskToLane(draggedTaskId, dropLane);
      endTaskDrag();
    },
    onCancel: endTaskDrag,
  });
  const backlogTasks = useMemo(() => tasks.filter((task) => !task.isRoutine), [tasks]);
  /* Routine definitions travel in the same list as their occurrences, so the
     board can name a task's parent routine without another request. */
  const routineTitles = useMemo(
    () => new Map(tasks.filter((task) => task.isRoutine).map((task) => [task.id, task.title])),
    [tasks],
  );
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
  const listPage = paginate(filteredTasks, page);
  const visibleTasks = view === "list" ? listPage.items : TASK_FLOW_STAGES.flatMap((status) => pagedLanes[status].items);
  const visibleIds = useMemo(() => visibleTasks.map((task) => task.id), [visibleTasks]);
  // Derived, not stored: a task hidden by a filter (or deleted elsewhere) drops
  // out of the selection immediately, so a batch action can never reach a
  // record the board is no longer showing.
  const visibleSelection = useMemo(() => pruneSelection(selection, visibleIds), [selection, visibleIds]);
  const selectedCount = visibleSelection.size;
  const draggedTask = useMemo(
    () => (draggedTaskId ? backlogTasks.find((task) => task.id === draggedTaskId) ?? null : null),
    [backlogTasks, draggedTaskId],
  );

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

  function linkedSession(task: RelayTaskListItem): RelaySession | undefined {
    const latest = task.linkedSessionIds?.at(-1);
    return latest ? sessions.find((session) => session.id === latest) : undefined;
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

  function beginTaskDrag(task: RelayTaskListItem, event: DragEvent<HTMLElement>) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(TASK_DRAG_MEDIA_TYPE, task.id);
    event.dataTransfer.setData("text/plain", task.title);
    setDraggedTaskId(task.id);
  }

  function endTaskDrag() {
    stopBoardScroll();
    setDraggedTaskId(null);
    setDropLane(null);
  }

  // The board hides its rightmost lanes on a laptop-width window and the
  // browser does not auto-scroll an overflow container mid-drag, so a card
  // dragged to the edge pulls the board along itself.
  function boardDragOver(event: DragEvent<HTMLDivElement>) {
    if (!draggedTask) return;
    trackBoardEdge(event.currentTarget, event.clientX);
  }

  function boardDragLeave(event: DragEvent<HTMLDivElement>) {
    // Crossing into a lane or a card also raises dragleave on the board; only
    // a pointer that has left the board entirely should halt the scroll.
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    stopBoardScroll();
  }

  // The lane a drop would land in, and whether it would be refused. Only the
  // hovered lane is decorated; a task's own lane stays neutral so hovering
  // back over the origin does not read as an error.
  function laneDropState(status: TaskStatus): "active" | "blocked" | undefined {
    if (!draggedTask || dropLane !== status) return undefined;
    const rejection = taskDropRejection(draggedTask, status);
    if (!rejection) return "active";
    return rejection === "needs_assignment" ? "blocked" : undefined;
  }

  function laneDragOver(status: TaskStatus, event: DragEvent<HTMLElement>) {
    // Without preventDefault the browser never fires `drop` on this element.
    if (!draggedTask) return;
    event.preventDefault();
    // The cursor must agree with the drop: a lane that refuses the drop (own
    // lane, or any rejection) reports "none", never a move it won't honour.
    const refused = draggedTask.status === status || Boolean(taskDropRejection(draggedTask, status));
    event.dataTransfer.dropEffect = refused ? "none" : "move";
    if (dropLane !== status) setDropLane(status);
  }

  function laneDragLeave(event: DragEvent<HTMLElement>) {
    // dragleave also fires when the pointer crosses into a child card, so keep
    // the lane highlighted until the pointer truly leaves it.
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDropLane(null);
  }

  // The single commit path for both input methods: HTML5 drops from a mouse
  // and press-and-hold drags from a finger.
  function moveTaskToLane(taskId: string | null, status: TaskStatus | null) {
    const task = taskId && status ? backlogTasks.find((candidate) => candidate.id === taskId) : undefined;
    if (!task || !status) return;
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

  function dropTaskInLane(status: TaskStatus, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const taskId = readDraggedTaskId(event.dataTransfer) ?? draggedTaskId;
    endTaskDrag();
    moveTaskToLane(taskId, status);
  }


  function taskHandlers(task: RelayTaskListItem) {
    const discussionAssignments = logicalAgents
      .filter((agent) => agent.enabled && agent.availability === "ready")
      .map((agent) => ({ agentId: agent.id, agent: agent.executorKind }));
    return {
      starting: startTaskMutation.isPending && startTaskMutation.variables?.taskId === task.id,
      onOpen: () => onOpenRecord(task.id),
      onEdit: () => editTask(task),
      onAssign: () => assignTask(task),
      onStart: () => {
        if (startInFlight.current) return;
        if (["review", "waiting_for_human"].includes(task.status)) {
          updateTaskMutation.mutate({ taskId: task.id, input: { status: "assigned" } });
          return;
        }
        startInFlight.current = task.id;
        startTaskMutation.mutate(taskStartMutationInput(task, discussionAssignments), {
          onSuccess: (result) => {
            if (!task.assignedAgentId && !task.assignedTeamId && result.session) onOpenThread(result.session.id);
          },
          onSettled: () => { startInFlight.current = null; },
        });
      },
      onToggleBlock: () => {
        if (task.status === "blocked") {
          updateTaskMutation.mutate({ taskId: task.id, input: { action: "unblock" } });
          return;
        }
        void prompt({ title: t("backlog.block_reason"), message: t("backlog.block_reason_hint") }).then((reason) => {
          if (reason?.trim()) updateTaskMutation.mutate({ taskId: task.id, input: { status: "blocked", blockerReason: reason.trim() } });
        });
      },
      onDone: () => void updateTaskMutation.mutate({ taskId: task.id, input: { status: "done" } }),
    };
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
            projectFilter={onSelectProject ? <FilterSelect
              size="sm"
              className="backlog-quick-select"
              name="task-project-filter"
              label={t("project.projects")}
              value={projectId ?? ""}
              onValueChange={(id) => onSelectProject(id || null)}
              options={[
                { value: "", label: t("project.all_projects") },
                ...projects.filter((project) => !project.archivedAt || project.id === projectId)
                  .map((project) => ({ value: project.id, label: project.name })),
              ]}
            /> : undefined}
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
          <Table className="backlog-rows-headwrap" aria-label={t("backlog.columns")}>
            <BacklogRowsHead
              compact
              sort={sort}
              onSort={toggleSort}
              selectAll={
                <TaskSelectAllCheckbox
                  state={selectionCheckState(visibleSelection, visibleIds)}
                  label={t("backlog.select_all_tasks")}
                  onToggle={() => setSelection((current) => toggleAllSelected(current, visibleIds))}
                />
              }
            />
          </Table>
          <Table className="routine-rows-body" aria-label={t("backlog.title")}>
            {listPage.items.map((task) => {
              const discussionAgents = discussionAgentsForTask(task, nodes, logicalAgents);
              const assignment = taskAssignmentDisplay(task);
              return (
                <BacklogTaskRow
                  key={task.id}
                  task={task}
                  projectName={projects.find((project) => project.id === task.projectId)?.name}
                  compact
                  session={linkedSession(task)}
                  routineTitle={task.sourceRoutineId ? routineTitles.get(task.sourceRoutineId) : undefined}
                  selected={visibleSelection.has(task.id)}
                  onToggleSelect={() => setSelection((current) => toggleSelected(current, task.id))}
                  agentDisplayName={assignment.name}
                  agentImageUrl={assignment.imageUrl}
                  ready={assignment.ready}
                  canDiscuss={canDiscussTask(task) && discussionAgents.length > 0}
                  {...taskHandlers(task)}
                />
              );
            })}
          </Table>
          <Pagination page={listPage} onPageChange={setPage} label={t("backlog.title")} />
        </div>
      ) : (
        <div
          ref={boardRef}
          className="backlog-board"
          data-dragging={draggedTask ? "true" : undefined}
          onDragOver={boardDragOver}
          onDragLeave={boardDragLeave}
        >
          {TASK_FLOW_STAGES.map((status) => (
            <section
              key={status}
              className="backlog-lane"
              data-status={status}
              data-drop={laneDropState(status)}
              aria-label={t(`backlog.statuses.${status}`)}
              onDragOver={(event) => laneDragOver(status, event)}
              onDragLeave={laneDragLeave}
              onDrop={(event) => dropTaskInLane(status, event)}
            >
              <header className="backlog-lane-head">
                <span className="backlog-lane-label">{t(`backlog.statuses.${status}`)}</span>
                <span className="backlog-lane-count tnum">{grouped[status].length}</span>
              </header>
              <div className="backlog-task-list">
                {grouped[status].length === 0 ? (
                  <p className="backlog-empty">{t("backlog.empty_lane")}</p>
                ) : pagedLanes[status].items.map((task) => {
                  const assignment = taskAssignmentDisplay(task);
                  return (
                    <BacklogTaskCard
                      key={task.id}
                      task={task}
                      projectName={projects.find((project) => project.id === task.projectId)?.name}
                      selected={visibleSelection.has(task.id)}
                      onToggleSelect={() => setSelection((current) => toggleSelected(current, task.id))}
                      agentDisplayName={assignment.name}
                      agentImageUrl={assignment.imageUrl}
                      ready={assignment.ready}
                      dragging={draggedTaskId === task.id}
                      onDragStart={(event) => beginTaskDrag(task, event)}
                      onDragEnd={endTaskDrag}
                      onTouchStart={(event) => touchDrag.onTouchStart(task.id, event)}
                      onOpen={() => onOpenRecord(task.id)}
                    />
                  );
                })}
                {(status === "backlog" || status === "assigned") ? (
                  <Button
                    variant="ghost"
                    type="button"
                    className="backlog-lane-add"
                    onClick={() => openTaskForm({ ...emptyBacklogForm(currentUser), status })}
                  >
                    <ActionAdd size={ICON.sm} />
                    <span>{t("backlog.new_task")}</span>
                  </Button>
                ) : null}
              </div>
              {/* Inside the lane, under its cards — the cursor belongs to this
                  lane and nothing about it is true of the board. */}
              <Pagination
                compact
                className="backlog-lane-pager"
                page={pagedLanes[status]}
                onPageChange={(next) => setLanePage(status, next)}
                label={t(`backlog.statuses.${status}`)}
              />
            </section>
          ))}
        </div>
      )}

      {/* A touch drag has no browser-drawn drag image, so the card's identity
          has to follow the finger explicitly. */}
      {touchDrag.point && draggedTask ? (
        <span className="backlog-drag-ghost" aria-hidden="true" style={dragGhostStyle(touchDrag.point)}>
          {draggedTask.title}
        </span>
      ) : null}

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
          onOpenThread={onOpenThread}
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
