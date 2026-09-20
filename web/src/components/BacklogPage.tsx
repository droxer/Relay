"use client";


import { TASK_FLOW_STAGES } from "../lib/taskFlow";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
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
import { agentReadyForTask, backlogSortColumns, canDiscussTask, discussionAgentsForTask, filterTasks, isTaskStatus, tasksByStatus } from "../lib/backlog";
import { applySort } from "../lib/listSort";
import { LANE_PAGE_SIZE, paginate } from "../lib/pagination";
import { useLanePagination } from "../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { useListSort } from "../hooks/useListSort";
import { SortMenu } from "@/components/ui/SortMenu";
import { readDraggedTaskId, TASK_DRAG_MEDIA_TYPE, taskDropRejection } from "../lib/taskDrag";
import { emptyBacklogForm, taskStartMutationInput } from "../lib/taskBoardForm";
import { TaskDrawer } from "./task-board/TaskDrawer";
import { TaskRecordView } from "./task-record/TaskRecordView";
import { InlineTaskCreate } from "./task-board/InlineTaskCreate";
import { taskCreateIntent } from "../lib/taskCreateIntent";
import { PageHeader } from "./PageHeader";
import { BoardEmpty } from "./BoardEmpty";
import { TaskBoardHeaderActions } from "./TaskBoardHeaderActions";
import { isTaskAssigneeCurrentUser, taskAssigneeDisplayName, teamReady } from "../lib/taskAssignment";
import { type CurrentUser, type DaemonNodeMonitorRecord, type RelaySession, type RelayTaskListItem, type TaskStatus } from "../types";
import { useEmployeeNames } from "../hooks/useEmployeeNames";
import { useEdgeAutoScroll } from "../hooks/useEdgeAutoScroll";
import { useUrlFilters } from "../hooks/useUrlFilters";
import { useTouchTaskDrag } from "../hooks/useTouchTaskDrag";
import { laneStatusAtPoint, type DragPoint } from "../lib/touchDrag";
import { writeViewPreference } from "../lib/viewPreference";
import { Button } from "@/components/ui/button";
import { taskRef } from "../lib/taskRef";


interface BacklogPageProps {
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
  BACKLOG_FILTER_SPEC,
  VIEW_STORAGE_KEY,
  initialFilters,
  parseBacklogView,
  type BacklogView,
} from "./task-board/backlogVocabulary";
import { BacklogStats, BacklogFiltersBar, BacklogViewToggle } from "./task-board/BacklogChrome";
import { BacklogRowsHead, BacklogTaskCard, BacklogTaskRow } from "./task-board/BacklogRecords";
import { ListGroup } from "./ListGroup";
import { TASK_STATUS_SHAPE } from "./task-board/backlogVocabulary";
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
import { Table, TableRow } from "@/components/ui/table";





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


export function BacklogPage({ recordTaskId, onOpenRecord, tasks, sessions, nodes, currentUser, isRefreshing, onRefresh, onOpenThread }: BacklogPageProps) {
  const { agents: logicalAgents } = useEmployeeAgents(currentUser.employeeId);
  const { teams } = useTeams(currentUser.employeeId);
  const employeeNames = useEmployeeNames(currentUser);
  const { t } = useTranslation();
  const { announce, confirm, prompt } = useDialogs();
  const {
    startTaskMutation,
    updateTaskMutation,
    createTaskMutation,
    deleteTaskMutation,
    deleteTasksMutation,
  } = useRelayMutations();
  // The filters live in the query string, so a filtered board survives
  // opening a record and coming back, and it is a link somebody can paste.
  const [filters, setFilters] = useUrlFilters(initialFilters, BACKLOG_FILTER_SPEC);
  const [view, setView] = useState<BacklogView>("board");
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
  } = useBacklogTaskForm({ currentUser });
  const [selection, setSelection] = useState<TaskSelection>(EMPTY_TASK_SELECTION);
  const [deletingSelection, setDeletingSelection] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropLane, setDropLane] = useState<TaskStatus | null>(null);
  // The lane whose inline create field is open, if any. Also the target
  // status for an inline create committed from the list view.
  const [inlineCreateStatus, setInlineCreateStatus] = useState<TaskStatus | null>(null);
  /* The record opens as a drawer over the board — the same shape the
     routines board uses, in both views here. The id is mirrored so the
     exiting drawer still has its record after the route clears; `onClosed`
     releases the mirror. */
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
    () => backlogSortColumns((task) => taskAssigneeDisplayName(task, currentUser, employeeNames) ?? ""),
    [currentUser, employeeNames],
  );
  const { sort, toggleSort, setSort } = useListSort(sortColumns);
  const { lanePages, setLanePage } = useLanePagination(TASK_FLOW_STAGES);
  const filteredTasks = useMemo(
    () => applySort(filterTasks(backlogTasks, filters), sortColumns, sort),
    [backlogTasks, filters, sort, sortColumns],
  );
  const grouped = useMemo(() => tasksByStatus(filteredTasks), [filteredTasks]);
  const hasFilterResults = filteredTasks.length > 0;
  const showEmptyBoard = backlogTasks.length === 0 || !hasFilterResults;
  /* Both views group by status, so both page per group off ONE cursor set:
     switching board/list keeps the reader on the same page of the same
     group. A single whole-list cursor cannot survive grouping — page 2 of
     the list would empty a band because of the cursor rather than because
     nothing is in that state. Built here rather than inside the render loop
     so the drag handlers below can ask what a lane is actually showing. */
  const pagedLanes = useMemo(
    () => Object.fromEntries(TASK_FLOW_STAGES.map((status) => [
      status,
      paginate(grouped[status], lanePages[status] ?? 1, LANE_PAGE_SIZE),
    ])) as Record<TaskStatus, ReturnType<typeof paginate<RelayTaskListItem>>>,
    [grouped, lanePages],
  );
  /* Selection follows what is on screen in both views, so "select all" then
     Delete cannot reach a card or row on a lane page the reader never saw. */
  const visibleTasks = TASK_FLOW_STAGES.flatMap((status) => pagedLanes[status].items);
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
  // that mounts it. Inline creation always seeds the backlog lane.
  useEffect(() => {
    const channel = taskCreateIntent();
    if (!channel) return;
    const openInlineCreate = () => {
      if (channel.consume()) setInlineCreateStatus("backlog");
    };
    openInlineCreate();
    return channel.subscribe(openInlineCreate);
  }, []);

  // Rapid-entry commit: on success the field stays open (Linear's card
  // creation rhythm); on failure the mutation's toast speaks and the text
  // stays put for a retry.
  async function submitInlineCreate(title: string): Promise<boolean> {
    if (!inlineCreateStatus) return false;
    try {
      await createTaskMutation.mutateAsync({ title, status: inlineCreateStatus });
      return true;
    } catch {
      return false;
    }
  }

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

  function taskAssignmentDisplay(task: RelayTaskListItem): { name?: string; ready: boolean } {
    const team = teams.find((candidate) => candidate.id === task.assignedTeamId);
    if (team) {
      return {
        name: team.name,
        ready: teamReady(team),
      };
    }
    return {
      name: logicalAgents.find((agent) => agent.id === task.assignedAgentId)?.displayName,
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
    <section id="backlog-panel" className="backlog-page" data-view={view} aria-label={t("backlog.title")} tabIndex={-1}>
      <PageHeader
        kicker={t("nav.workspace")}
        title={t("backlog.title")}
        count={t("backlog.sub", { count: backlogTasks.length })}
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

      {backlogTasks.length > 0 ? (
        <>
          <BacklogStats tasks={backlogTasks} />
          <BacklogFiltersBar
            filters={filters}
            agents={logicalAgents}
            onChange={setFilters}
            sortMenu={
              <SortMenu
                /* No `status` entry: both views group by status, so sorting
                   by it can only reorder rows inside a band that already
                   holds one status. The key stays valid for old links. */
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
          const filtered = backlogTasks.length > 0 && !hasFilterResults;
          return (
            <BoardEmpty
              title={filtered ? t("backlog.no_match_title") : t("backlog.no_tasks_title")}
              body={filtered ? t("backlog.no_match_body") : t("backlog.no_tasks_body")}
              createLabel={filtered ? undefined : t("backlog.new_task")}
              onCreate={filtered ? undefined : () => openTaskForm(emptyBacklogForm(currentUser))}
              clearLabel={filtered ? t("backlog.clear_filters") : undefined}
              onClear={filtered ? () => setFilters(initialFilters) : undefined}
            />
          );
        })()
      ) : view === "list" ? (
        /* Grouped by status, same dimension the board lanes on — which is
           what buys the columns back: a row under a band that says "Blocked"
           does not have to spend 96px repeating it.

           The column header is hoisted out of the groups and rendered once,
           sticky, above all of them — see BacklogRowsHead for why it stopped
           repeating. Its select-all therefore covers every visible row on the
           page rather than one band's worth. */
        <div className="backlog-rows" data-density="compact">
          <Table className="backlog-rows-headwrap" aria-label={t("backlog.columns")}>
            <BacklogRowsHead
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
          {TASK_FLOW_STAGES.map((status) => {
            const group = grouped[status];
            const opening = inlineCreateStatus === status;
            // An empty band is noise unless it is where the reader is typing.
            if (group.length === 0 && !opening) return null;
            const label = t(`backlog.statuses.${status}`);
            const groupPage = pagedLanes[status];
            return (
              <ListGroup
                key={status}
                data-status={status}
                label={label}
                count={group.length}
                shape={TASK_STATUS_SHAPE[status]}
                addLabel={t("backlog.new_task")}
                onAdd={status === "backlog" ? () => setInlineCreateStatus(status) : status === "assigned" ? () => openTaskForm({ ...emptyBacklogForm(currentUser), status: "assigned" }) : undefined}
              >
                <Table className="list-group-rows" aria-label={label}>
                  {opening ? (
                    <TableRow className="backlog-inline-create-row">
                      <InlineTaskCreate
                        onSubmit={submitInlineCreate}
                        onClose={() => setInlineCreateStatus(null)}
                      />
                    </TableRow>
                  ) : null}
                  {groupPage.items.map((task) => {
                    const discussionAgents = discussionAgentsForTask(task, nodes, logicalAgents);
                    const assignment = taskAssignmentDisplay(task);
                    return (
                      <BacklogTaskRow
                        key={task.id}
                        task={task}
                        session={linkedSession(task)}
                        routineTitle={task.sourceRoutineId ? routineTitles.get(task.sourceRoutineId) : undefined}
                        selected={visibleSelection.has(task.id)}
                        onToggleSelect={() => setSelection((current) => toggleSelected(current, task.id))}
                        assigneeDisplayName={taskAssigneeDisplayName(task, currentUser, employeeNames)}
                        assigneeIsSelf={isTaskAssigneeCurrentUser(task, currentUser)}
                        agentDisplayName={assignment.name}
                        ready={assignment.ready}
                        canDiscuss={canDiscussTask(task) && discussionAgents.length > 0}
                        {...taskHandlers(task)}
                      />
                    );
                  })}
                </Table>
                {/* The band's own cursor, under its own rows — the same
                    control the lane carries on the board. */}
                <Pagination
                  compact
                  className="list-group-pager"
                  page={groupPage}
                  onPageChange={(next) => setLanePage(status, next)}
                  label={label}
                />
              </ListGroup>
            );
          })}
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
                {grouped[status].length === 0 && inlineCreateStatus !== status ? (
                  <p className="backlog-empty">{t("backlog.empty_lane")}</p>
                ) : pagedLanes[status].items.map((task) => {
                  const assignment = taskAssignmentDisplay(task);
                  return (
                    <BacklogTaskCard
                      key={task.id}
                      task={task}
                      selected={visibleSelection.has(task.id)}
                      onToggleSelect={() => setSelection((current) => toggleSelected(current, task.id))}
                      assigneeDisplayName={taskAssigneeDisplayName(task, currentUser, employeeNames)}
                      assigneeIsSelf={isTaskAssigneeCurrentUser(task, currentUser)}
                      agentDisplayName={assignment.name}
                      ready={assignment.ready}
                      dragging={draggedTaskId === task.id}
                      onDragStart={(event) => beginTaskDrag(task, event)}
                      onDragEnd={endTaskDrag}
                      onTouchStart={(event) => touchDrag.onTouchStart(task.id, event)}
                      onOpen={() => onOpenRecord(task.id)}
                    />
                  );
                })}
                {inlineCreateStatus === status ? (
                  <InlineTaskCreate
                    onSubmit={submitInlineCreate}
                    onClose={() => setInlineCreateStatus(null)}
                  />
                ) : (status === "backlog" || status === "assigned") ? (
                  <Button
                    variant="ghost"
                    type="button"
                    className="backlog-lane-add"
                    onClick={() => status === "assigned" ? openTaskForm({ ...emptyBacklogForm(currentUser), status: "assigned" }) : setInlineCreateStatus("backlog")}
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

      {/* The record rides over the board rather than replacing it — the same
          drawer the routines board opens, in both views here. Editing still
          happens here: the record delegates `onEdit` up, and the form drawer
          stacks above the record's. */}
      {drawerRecordId ? (
        <TaskRecordView
          taskId={drawerRecordId}
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
