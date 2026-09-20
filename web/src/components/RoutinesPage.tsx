"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useUrlFilters } from "../hooks/useUrlFilters";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { useEmployeeAgents } from "../hooks/useEmployeeAgents";
import { useTeams } from "../hooks/useTeams";
import { useDialogs } from "@/components/ui/DialogProvider";
import { type CurrentUser, type DaemonNodeMonitorRecord, type RelayTaskListItem } from "../types";
import { agentReadyForTask } from "../lib/backlog";
import { isTaskAssigneeCurrentUser, taskAssigneeDisplayName, teamReady } from "../lib/taskAssignment";
import { useEmployeeNames } from "../hooks/useEmployeeNames";
import { filterRoutineTasks, routineSortColumns, routineState, routineStateCounts, runningRoutineIds } from "../lib/routine";
import { applySort } from "../lib/listSort";
import { paginate } from "../lib/pagination";
import { usePagination } from "../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { useListSort } from "../hooks/useListSort";
import { SortMenu } from "@/components/ui/SortMenu";
import { emptyRoutineForm, taskAssignmentMutationFields, taskBoardFormsEqual, taskStartMutationInput, type RoutineTaskFormState } from "../lib/taskBoardForm";
import { TaskDrawer } from "./task-board/TaskDrawer";
import { TaskRecordView } from "./task-record/TaskRecordView";
import { useRecordDrawerMirror } from "../hooks/useRecordDrawerMirror";
import {
  activeRoutineFilterCount,
  initialRoutineFilters,
  ROUTINE_FILTER_SPEC,
  RoutineFiltersBar,
  RoutineStateNav,
} from "./task-board/RoutineChrome";
import {
  RoutineRow,
  RoutineRowsHead,
} from "./task-board/RoutineRecords";
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
import { PageHeader } from "./PageHeader";
import { BoardEmpty } from "./BoardEmpty";
import { TaskBoardHeaderActions } from "./TaskBoardHeaderActions";
import { Table } from "@/components/ui/table";
import { taskRef } from "../lib/taskRef";

interface RoutinesPageProps {
  /** The routine whose record is open, from `/routines/<id>`. */
  recordTaskId?: string | null;
  /** The occurrence open as a run, from `/routines/<id>/runs/<runId>`. */
  recordRunId?: string | null;
  /** Opens a record; `null` returns to the board. */
  onOpenRecord: (routineId: string | null, runId?: string | null) => void;
  tasks: RelayTaskListItem[];
  nodes: DaemonNodeMonitorRecord[];
  currentUser: CurrentUser;
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
  onOpenThread: (sessionId: string) => void;
}

export function RoutinesPage({ recordTaskId, recordRunId, onOpenRecord, tasks, nodes, currentUser, isRefreshing, onRefresh, onOpenThread }: RoutinesPageProps) {
  const { agents: logicalAgents } = useEmployeeAgents(currentUser.employeeId);
  const { teams } = useTeams(currentUser.employeeId);
  const employeeNames = useEmployeeNames(currentUser);
  const { t } = useTranslation();
  const { announce, confirm } = useDialogs();
  const {
    startTaskMutation,
    updateTaskMutation,
    createTaskMutation,
    deleteTaskMutation,
    deleteTasksMutation,
  } = useRelayMutations();
  // The filters live in the query string — same reasoning as the backlog's.
  const [filters, setFilters] = useUrlFilters(initialRoutineFilters, ROUTINE_FILTER_SPEC);
  const [form, setForm] = useState<RoutineTaskFormState | null>(null);
  const [formBaseline, setFormBaseline] = useState<RoutineTaskFormState | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [assignmentFocus, setAssignmentFocus] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selection, setSelection] = useState<TaskSelection>(EMPTY_TASK_SELECTION);
  const [deletingSelection, setDeletingSelection] = useState(false);
  const startInFlight = useRef<string | null>(null);
  const formDirty = Boolean(form && formBaseline && !taskBoardFormsEqual(form, formBaseline));
  const confirmDiscardChanges = useUnsavedChangesGuard(formDirty && !saving && !deleting);
  const routineTasks = useMemo(() => tasks.filter((task) => task.isRoutine), [tasks]);
  // Derived once for the whole board: `routineState` then costs a Set lookup
  // per row instead of a full task scan.
  const runningIds = useMemo(() => runningRoutineIds(tasks), [tasks]);
  /* Unsorted, `applySort` is the identity and `filterRoutineTasks`' own order
     (enabled first, then next run) stands — schedule health is the rail's
     dimension, not a column, so no comparator reads it. */
  const sortColumns = useMemo(
    () => routineSortColumns((task) => taskAssigneeDisplayName(task, currentUser, employeeNames) ?? ""),
    [currentUser, employeeNames],
  );
  const { sort, toggleSort, setSort } = useListSort(sortColumns);
  const { page, setPage } = usePagination();
  const filteredTasks = useMemo(
    () => applySort(filterRoutineTasks(tasks, filters), sortColumns, sort),
    [filters, sort, sortColumns, tasks],
  );
  /* The rail's numbers answer "how many of what I am looking at are
     overdue", so they are counted against every filter EXCEPT the one the
     rail itself owns. Counting the already-narrowed list would put the whole
     board in the selected section and a 0 beside every other one. */
  const sectionCounts = useMemo(
    () => routineStateCounts(filterRoutineTasks(tasks, { ...filters, state: "all" }), runningIds),
    [filters, runningIds, tasks],
  );
  const sectionTotal = useMemo(
    () => Object.values(sectionCounts).reduce((sum, count) => sum + count, 0),
    [sectionCounts],
  );
  /* One flat collection on one cursor. Schedule health used to band this
     list — and page each band off its own cursor — but the rail beside it
     names the section now, so a band would only repeat it. */
  const pagedTasks = useMemo(() => paginate(filteredTasks, page), [filteredTasks, page]);
  // Selection follows what is on screen, so "select all" then Delete cannot
  // reach a routine on a page the reader never saw.
  const visibleIds = useMemo(
    () => pagedTasks.items.map((task) => task.id),
    [pagedTasks],
  );
  // Derived, not stored: a routine hidden by a filter (or deleted elsewhere)
  // drops out of the selection immediately, so a batch action can never reach
  // a record the board is no longer showing.
  const visibleSelection = useMemo(() => pruneSelection(selection, visibleIds), [selection, visibleIds]);

  function openRoutineForm(next: RoutineTaskFormState) {
    setForm(next);
    setFormBaseline(next);
    setDrawerOpen(true);
  }

  // The drawer calls this after its exit animation completes — only then is
  // the form released, so every exit (save, delete, discard) animates out.
  function releaseRoutineForm() {
    setForm(null);
    setFormBaseline(null);
    setAssignmentFocus(false);
  }

  function dismissRoutineForm() {
    setDrawerOpen(false);
  }

  async function closeRoutineForm() {
    if (!drawerOpen || saving || deleting) return;
    if (!(await confirmDiscardChanges())) return;
    dismissRoutineForm();
  }

  function editTask(task: RelayTaskListItem) {
    openRoutineForm({
      variant: "routine",
      id: task.id,
      title: task.title,
      acceptancePolicy: task.acceptancePolicy ?? "automatic",
      description: task.description,
      priority: task.priority,
      assigneeEmployeeId: task.assigneeEmployeeId ?? task.ownerEmployeeId ?? currentUser.employeeId ?? currentUser.username,
      assignedAgent: task.assignedAgent ?? "",
      assignedAgentId: task.assignedAgentId ?? "",
      assignedTeamId: task.assignedTeamId ?? "",
      routineType: task.routineType ?? "task",
      routineCadence: task.routineCadence ?? "weekly",
      routineNextRunDate: task.routineNextRunDate ?? "",
      routineEnabled: task.routineEnabled,
    });
  }

  async function submitRoutine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !form.title.trim()) return;
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        acceptancePolicy: form.acceptancePolicy ?? "human",
        description: form.description,
        priority: form.priority,
        isRoutine: true,
        routineType: form.routineType,
        routineCadence: form.routineCadence,
        routineEnabled: form.routineEnabled,
        ...(form.routineCadence === "custom"
          ? { routineNextRunDate: form.routineNextRunDate }
          : {}),
        ...taskAssignmentMutationFields(form),
      };
      if (form.id) await updateTaskMutation.mutateAsync({ taskId: form.id, input: payload });
      else await createTaskMutation.mutateAsync(payload);
      dismissRoutineForm();
    } catch {
      // mutation onError surfaces a toast; keep the drawer open for retry.
    } finally {
      setSaving(false);
    }
  }

  async function deleteRoutine() {
    if (!form?.id || deleting) return;
    const confirmed = await confirm({
      title: t("routine.delete_title"),
      message: t("routine.delete_body", { title: form.title }),
      confirmLabel: t("routine.delete_task"),
      cancelLabel: t("dialog.cancel"),
      tone: "danger",
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await deleteTaskMutation.mutateAsync({ taskId: form.id });
      dismissRoutineForm();
      announce({ message: t("routine.toast_deleted"), tone: "success" });
    } catch {
      // mutation onError surfaces a toast; keep the drawer open for retry.
    } finally {
      setDeleting(false);
    }
  }

  async function deleteSelectedRoutines() {
    const targets = selectedTasks(filteredTasks, visibleSelection);
    if (targets.length === 0 || deletingSelection) return;
    const confirmed = await confirm({
      title: t("routine.bulk_delete_title", { count: targets.length }),
      message: t("routine.bulk_delete_body", { count: targets.length }),
      confirmLabel: t("routine.delete_selected"),
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
        announce({ message: t("routine.toast_bulk_deleted", { count: succeeded.length }), tone: "success" });
      }
    } catch {
      // mutation onError surfaces a toast; the selection stays put for a retry.
    } finally {
      setDeletingSelection(false);
    }
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

  /* The record opens as a drawer over the board: the URL says which record,
     and the board stays put beneath it. The mirror keeps the last open record
     around through the drawer's exit animation — the URL has already moved on
     by then, the same deferral the form drawer gets from `onClosed`. */
  const recordMirror = useRecordDrawerMirror(
    recordTaskId ? `${recordTaskId}\u0000${recordRunId ?? ""}` : null,
    recordTaskId ? { taskId: recordTaskId, runId: recordRunId ?? null } : null,
  );
  const drawerRecord = recordMirror.record;

  /* The content column's header names the section the rail has selected —
     the rail names the surface. */
  const sectionLabel = filters.state === "all"
    ? t("routine.all_states")
    : t(`routine.states.${filters.state}`);

  /* The rail already carries the selected section's count, so the board's own
     header restates it whenever the bar is clear. It earns the number only
     once a filter or the search box has narrowed the section below what the
     rail says. */
  const sectionNarrowed = activeRoutineFilterCount(filters) > 0 || filters.query.trim().length > 0;

  // Quick-assign entry from a card/row: same drawer, focus on the picker.
  function assignTask(task: RelayTaskListItem) {
    setAssignmentFocus(true);
    editTask(task);
  }

  function routineHandlers(task: RelayTaskListItem) {
    return {
      starting: startTaskMutation.isPending && startTaskMutation.variables?.taskId === task.id,
      onOpen: () => onOpenRecord(task.id),
      onEdit: () => editTask(task),
      onAssign: () => assignTask(task),
      onStart: () => {
        if (startInFlight.current) return;
        startInFlight.current = task.id;
        startTaskMutation.mutate(taskStartMutationInput(task), {
          onSettled: () => { startInFlight.current = null; },
        });
      },
    };
  }

  return (
    <section id="routine-panel" className="routine-page sec-shell" aria-label={t("routine.title")} tabIndex={-1}>
      {/* The rail names the surface and lists its sections; the board's own
          header names the section being read. Same rail-and-content shape as
          the control panel and personal settings — see section-rail.css. */}
      <div className="sec-rail">
        {/* Kicker + title + count, like every other rail in the app. The count
            rides beside the title rather than under it: a third line is the
            one shape that cannot sit on the surface's shared header step
            (--sec-header-h in section-rail.css). */}
        <PageHeader
          kicker={t("nav.workspace")}
          title={t("routine.title")}
          count={t("routine.sub", { count: routineTasks.length })}
          titleVariant="display"
          layout="stacked"
        />
        <RoutineStateNav
          value={filters.state}
          counts={sectionCounts}
          total={sectionTotal}
          onChange={(state) => setFilters({ ...filters, state })}
        />
      </div>

      <div className="sec-main">
        <PageHeader
          title={sectionLabel}
          titleAs="h2"
          titleVariant="display"
          count={sectionNarrowed ? t("routine.sub", { count: filteredTasks.length }) : undefined}
          actions={
            <TaskBoardHeaderActions
              refreshLabel={t("nav.refresh")}
              createLabel={t("routine.new")}
              isRefreshing={isRefreshing}
              onRefresh={() => void onRefresh()}
              onCreate={() => openRoutineForm(emptyRoutineForm(currentUser))}
            />
          }
        />

        <RoutineFiltersBar
          filters={filters}
          agents={logicalAgents}
          onChange={setFilters}
          sortMenu={
            <SortMenu
              options={[
                { key: "title", label: t("backlog.col_task") },
                { key: "priority", label: t("backlog.priority") },
                { key: "assignee", label: t("backlog.assignee") },
                { key: "nextRun", label: t("routine.next_run") },
              ]}
              sort={sort}
              onSortChange={setSort}
              label={t("routine.sort_label")}
            />
          }
        />

        {filteredTasks.length === 0 ? (
          <BoardEmpty
            title={routineTasks.length === 0 ? t("routine.no_routines_title") : t("routine.no_match_title")}
            body={routineTasks.length === 0 ? t("routine.no_routines_body") : t("routine.no_match_body")}
            createLabel={routineTasks.length === 0 ? t("routine.new") : undefined}
            onCreate={routineTasks.length === 0 ? () => openRoutineForm(emptyRoutineForm(currentUser)) : undefined}
          />
        ) : (
          /* One table, one header, no bands: the rail beside this list has
             already said which schedule state is on screen.

             `data-density="compact"` is the same scope the backlog list opts
             into. The two lists are one record grammar (see RoutineRecords),
             and this one was running at the root rhythm while the backlog ran
             compact — a 77px routine row against a 52px task row for the same
             kind of record. */
          <>
            <div className="backlog-rows routine-rows" data-density="compact">
              <Table className="backlog-rows-headwrap" aria-label={t("backlog.columns")}>
                <RoutineRowsHead
                  sort={sort}
                  onSort={toggleSort}
                  selectAll={
                    <TaskSelectAllCheckbox
                      state={selectionCheckState(visibleSelection, visibleIds)}
                      label={t("routine.select_all_routines")}
                      onToggle={() => setSelection((current) => toggleAllSelected(current, visibleIds))}
                    />
                  }
                />
              </Table>
              <Table className="routine-rows-body" aria-label={sectionLabel}>
                {pagedTasks.items.map((task) => {
                  const assignment = taskAssignmentDisplay(task);
                  return (
                    <RoutineRow
                      key={task.id}
                      task={task}
                      selected={visibleSelection.has(task.id)}
                      onToggleSelect={() => setSelection((current) => toggleSelected(current, task.id))}
                      state={routineState(task, runningIds)}
                      assigneeDisplayName={taskAssigneeDisplayName(task, currentUser, employeeNames)}
                      assigneeIsSelf={isTaskAssigneeCurrentUser(task, currentUser)}
                      agentDisplayName={assignment.name}
                      ready={assignment.ready}
                      {...routineHandlers(task)}
                    />
                  );
                })}
              </Table>
            </div>
            <Pagination page={pagedTasks} onPageChange={setPage} label={sectionLabel} />
          </>
        )}
      </div>

      <TaskSelectionBar
        count={visibleSelection.size}
        deleting={deletingSelection}
        deleteLabel={t("routine.delete_selected")}
        onDelete={() => { void deleteSelectedRoutines(); }}
        onClear={() => setSelection(EMPTY_TASK_SELECTION)}
      />

      {form ? (
        <TaskDrawer
          open={drawerOpen}
          form={form}
          logicalAgents={logicalAgents}
          teams={teams}
          saving={saving}
          deleting={deleting}
          initialFocus={assignmentFocus ? "assignment" : "title"}
          title={form.id ? t("routine.edit") : t("routine.new")}
          subtitle={form.id ? `${t("backlog.col_ref")} ${taskRef(form.id)}` : t("routine.new_routine_id")}
          onClose={() => { void closeRoutineForm(); }}
          onClosed={releaseRoutineForm}
          onChange={(next) => {
            if (next.variant === "routine") setForm(next);
          }}
          onSubmit={(event) => void submitRoutine(event)}
          onDelete={form.id ? () => { void deleteRoutine(); } : undefined}
          layer={drawerRecord ? 1 : 0}
        />
      ) : null}

      {/* The record rides over the board rather than replacing it: the rail
          and the list keep their places — and their filters, which the record
          route now carries — while the drawer is open. Editing still happens
          here: the record delegates `onEdit` up, and the form drawer stacks
          above the record's. */}
      {drawerRecord ? (
        <TaskRecordView
          taskId={drawerRecord.taskId}
          runId={drawerRecord.runId}
          tasks={tasks}
          drawer={{
            open: Boolean(recordTaskId),
            onClose: () => onOpenRecord(null),
            onClosed: recordMirror.release,
          }}
          onEdit={editTask}
          onOpenThread={onOpenThread}
          onOpenRecord={onOpenRecord}
          onDeleted={() => onOpenRecord(null)}
        />
      ) : null}
    </section>
  );
}
