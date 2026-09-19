"use client";

import { TaskRecoveryPanel } from "./ExecutionRecoveryPanel";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useUrlFilters } from "../hooks/useUrlFilters";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { useEmployeeAgents } from "../hooks/useEmployeeAgents";
import { useTeams } from "../hooks/useTeams";
import { useDialogs } from "@/components/ui/DialogProvider";
import { type CurrentUser, type DaemonNodeMonitorRecord, type RelaySession, type RelayTaskListItem } from "../types";
import { agentReadyForTask } from "../lib/backlog";
import { isTaskAssigneeCurrentUser, taskAssigneeDisplayName, teamReady } from "../lib/taskAssignment";
import { useEmployeeNames } from "../hooks/useEmployeeNames";
import { writeViewPreference } from "../lib/viewPreference";
import { filterRoutineTasks, latestRoutineSession, routineSortColumns, routineState, routineStateCounts, runningRoutineIds } from "../lib/routine";
import { applySort } from "../lib/listSort";
import { paginate } from "../lib/pagination";
import { usePagination } from "../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { useListSort } from "../hooks/useListSort";
import { SortMenu } from "@/components/ui/SortMenu";
import { emptyRoutineForm, taskAssignmentMutationFields, taskBoardFormsEqual, taskStartMutationInput, type RoutineTaskFormState } from "../lib/taskBoardForm";
import { TaskDrawer } from "./task-board/TaskDrawer";
import {
  initialRoutineFilters,
  parseRoutineView,
  ROUTINE_FILTER_SPEC,
  RoutineFiltersBar,
  RoutineStateNav,
  RoutineStats,
  RoutineViewToggle,
  ROUTINE_VIEW_STORAGE_KEY,
  type RoutineView,
} from "./task-board/RoutineChrome";
import {
  RoutineCard,
  RoutineDrawerMeta,
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
  tasks: RelayTaskListItem[];
  sessions: RelaySession[];
  nodes: DaemonNodeMonitorRecord[];
  currentUser: CurrentUser;
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
  onOpenThread: (sessionId: string) => void;
}

export function RoutinesPage({ tasks, sessions, nodes, currentUser, isRefreshing, onRefresh, onOpenThread }: RoutinesPageProps) {
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
  const [view, setView] = useState<RoutineView>("card");
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
  // per card instead of a full task scan.
  const runningIds = useMemo(() => runningRoutineIds(tasks), [tasks]);
  /* The state column sorts by DERIVED schedule health, so its comparator has
     to close over the same `runningIds` the rows render from — see
     `routineSortColumns`. Unsorted, `applySort` is the identity and
     `filterRoutineTasks`' own order (enabled first, then next run) stands. */
  const sortColumns = useMemo(
    () => routineSortColumns(runningIds, (task) => taskAssigneeDisplayName(task, currentUser, employeeNames) ?? ""),
    [currentUser, employeeNames, runningIds],
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
  /* One flat collection on one cursor, in either view. Schedule health used
     to band this list — and page each band off its own cursor — but the rail
     beside it names the section now, so a band would only repeat it. */
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

  // Browser storage is unavailable to the server. Restore it after hydration
  // so the initial server and client trees always agree.
  useEffect(() => {
    setView(parseRoutineView(null));
  }, []);

  function changeView(next: RoutineView) {
    /* The list orders by its column headers, and it has no state column —
       the dot cell shows the state but nothing sorts on it. So a state sort
       carried over from the cards would be an active order with no control
       showing it. (Not a grouping concern: nothing on this board groups.) */
    if (next === "list" && sort?.key === "state") setSort(null);
    setView(next);
    writeViewPreference(ROUTINE_VIEW_STORAGE_KEY, next);
  }

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

  function linkedSession(task: RelayTaskListItem): RelaySession | undefined {
    return latestRoutineSession(task, tasks, sessions);
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

  /* The content column's header names the section the rail has selected —
     the rail names the surface. */
  const sectionLabel = filters.state === "all"
    ? t("routine.all_states")
    : t(`routine.states.${filters.state}`);

  const editingTask = form?.id ? tasks.find((task) => task.id === form.id) : undefined;
  const editingSession = editingTask ? linkedSession(editingTask) : undefined;

  // Quick-assign entry from a card/row: same drawer, focus on the picker.
  function assignTask(task: RelayTaskListItem) {
    setAssignmentFocus(true);
    editTask(task);
  }

  function routineHandlers(task: RelayTaskListItem) {
    return {
      starting: startTaskMutation.isPending && startTaskMutation.variables?.taskId === task.id,
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
    <section id="routine-panel" className="routine-page sec-shell" data-view={view} aria-label={t("routine.title")} tabIndex={-1}>
      {/* The rail names the surface and lists its sections; the board's own
          header names the section being read. Same rail-and-content shape as
          the control panel and personal settings — see section-rail.css. */}
      <div className="sec-rail">
        <PageHeader
          kicker={t("nav.workspace")}
          title={t("routine.title")}
          subtitle={t("routine.sub", { count: routineTasks.length })}
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
          count={t("routine.sub", { count: filteredTasks.length })}
          actions={
            <TaskBoardHeaderActions
              leading={<RoutineViewToggle view={view} onChange={changeView} />}
              refreshLabel={t("nav.refresh")}
              createLabel={t("routine.new")}
              isRefreshing={isRefreshing}
              onRefresh={() => void onRefresh()}
              onCreate={() => openRoutineForm(emptyRoutineForm(currentUser))}
            />
          }
        />

        <RoutineStats routines={routineTasks} tasks={tasks} />
        <RoutineFiltersBar
          filters={filters}
          agents={logicalAgents}
          onChange={setFilters}
          sortMenu={
            <SortMenu
              options={[
                { key: "title", label: t("backlog.col_task") },
                ...(view === "card" ? [{ key: "state" as const, label: t("routine.state") }] : []),
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
        ) : view === "list" ? (
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
                  const session = linkedSession(task);
                  const assignment = taskAssignmentDisplay(task);
                  return (
                    <RoutineRow
                      key={task.id}
                      task={task}
                      selected={visibleSelection.has(task.id)}
                      onToggleSelect={() => setSelection((current) => toggleSelected(current, task.id))}
                      state={routineState(task, runningIds)}
                      session={session}
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
        ) : (
          <>
            <div className="routine-list">
            {pagedTasks.items.map((task) => {
              const assignment = taskAssignmentDisplay(task);
              return (
                <RoutineCard
                  key={task.id}
                  task={task}
                  selected={visibleSelection.has(task.id)}
                  onToggleSelect={() => setSelection((current) => toggleSelected(current, task.id))}
                  state={routineState(task, runningIds)}
                  showState={filters.state === "all"}
                  assigneeDisplayName={taskAssigneeDisplayName(task, currentUser, employeeNames)}
                  assigneeIsSelf={isTaskAssigneeCurrentUser(task, currentUser)}
                  agentDisplayName={assignment.name}
                  ready={assignment.ready}
                  {...routineHandlers(task)}
                />
              );
            })}
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
          meta={editingTask ? (
            <>
              {/* The meta row below already links this occurrence's thread. */}
              <TaskRecoveryPanel task={editingTask} excludeSessionId={editingSession?.id} onOpenThread={onOpenThread} />
              <RoutineDrawerMeta
                task={editingTask}
                state={routineState(editingTask, runningIds)}
                session={editingSession}
                onOpenThread={onOpenThread}
              />
            </>
          ) : undefined}
          onClose={() => { void closeRoutineForm(); }}
          onClosed={releaseRoutineForm}
          onChange={(next) => {
            if (next.variant === "routine") setForm(next);
          }}
          onOpenThread={onOpenThread}
          onSubmit={(event) => void submitRoutine(event)}
          onDelete={form.id ? () => { void deleteRoutine(); } : undefined}
        />
      ) : null}
    </section>
  );
}
