"use client";

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
import { filterRoutineTasks, latestRoutineSession, routineSortColumns, routineState, runningRoutineIds } from "../lib/routine";
import { applySort } from "../lib/listSort";
import { paginate } from "../lib/pagination";
import { usePagination } from "../hooks/usePagination";
import { Pagination } from "@/components/ui/Pagination";
import { useListSort } from "../hooks/useListSort";
import { SortMenu } from "@/components/ui/SortMenu";
import { emptyRoutineForm, taskAssignmentMutationFields, taskBoardFormsEqual, taskStartMutationInput, type RoutineTaskFormState } from "../lib/taskBoardForm";
import {
  activeRoutineFilterCount,
  initialRoutineFilters,
  ROUTINE_FILTER_SPEC,
  RoutineFiltersBar,
} from "./task-board/RoutineChrome";
import { RoutineRosterRail } from "./task-board/RoutineRosterRail";
import { RoutineDetail } from "./task-board/RoutineDetail";
import { RoutineRow, RoutineRowsHead } from "./task-board/RoutineRecords";
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
import { NEW_ROUTINE_ID } from "../lib/appRoute";

interface RoutinesPageProps {
  tasks: RelayTaskListItem[];
  sessions: RelaySession[];
  nodes: DaemonNodeMonitorRecord[];
  currentUser: CurrentUser;
  isRefreshing: boolean;
  /** The routine open in the detail pane, from the path. NEW_ROUTINE_ID drafts one. */
  routineId: string | null;
  onSelectRoutine: (routineId: string | null) => void;
  onRefresh: () => Promise<void>;
  onOpenThread: (sessionId: string) => void;
}

/**
 * The routine board: a roster rail of routines beside the record that is open.
 *
 * The rail used to be a SectionNav of schedule states, with every routine in a
 * table and a drawer over it for editing — three surfaces for one record. Now
 * the rail lists the routines themselves (state riding on each row as its
 * mark), the pane holds whichever one is selected, and the table is what the
 * pane shows when nothing is: the place to sort, batch, and dispatch across
 * the whole set. Selection lives in the path (`/routines/<id>`), like every
 * other record surface in the app.
 */
export function RoutinesPage({ tasks, sessions, nodes, currentUser, isRefreshing, routineId, onSelectRoutine, onRefresh, onOpenThread }: RoutinesPageProps) {
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
  const [assignmentFocus, setAssignmentFocus] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selection, setSelection] = useState<TaskSelection>(EMPTY_TASK_SELECTION);
  const [deletingSelection, setDeletingSelection] = useState(false);
  const startInFlight = useRef<string | null>(null);
  const formDirty = Boolean(form && formBaseline && !taskBoardFormsEqual(form, formBaseline));
  /* Registers a navigation guard, so leaving a dirty record — a rail row, the
     side nav, the back button — asks first. The pane has no close button to
     hang that question off, which is exactly why the guard is global. */
  useUnsavedChangesGuard(formDirty && !saving && !deleting);
  const drafting = routineId === NEW_ROUTINE_ID;
  const routineTasks = useMemo(() => tasks.filter((task) => task.isRoutine), [tasks]);
  // Derived once for the whole board: `routineState` then costs a Set lookup
  // per row instead of a full task scan.
  const runningIds = useMemo(() => runningRoutineIds(tasks), [tasks]);
  const stateOf = useMemo(
    () => (task: RelayTaskListItem) => routineState(task, runningIds),
    [runningIds],
  );
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
  /* The rail and the table read the same filtered set: the rail's search and
     state select ARE this board's filters, so a routine the table cannot show
     is not reachable from the rail either. The rail is unpaged — a rail row is
     cheap, and a cursor there would hide records the table counts. */
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

  const selectedRoutine = useMemo(
    () => (routineId && !drafting ? routineTasks.find((task) => task.id === routineId) : undefined),
    [drafting, routineId, routineTasks],
  );

  function loadRoutineForm(next: RoutineTaskFormState) {
    setForm(next);
    setFormBaseline(next);
  }

  function routineFormFor(task: RelayTaskListItem): RoutineTaskFormState {
    return {
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
    };
  }

  /* The form is loaded from the path, ONCE per record. `selectedRoutine` is in
     the dependency list because a deep link can arrive before the board has
     loaded; the ref is what stops the next poll from overwriting a half-typed
     edit with the server's copy of the same routine. */
  const loadedRoutineId = useRef<string | null>(null);
  useEffect(() => {
    if (!routineId) {
      loadedRoutineId.current = null;
      setForm(null);
      setFormBaseline(null);
      setAssignmentFocus(false);
      return;
    }
    if (loadedRoutineId.current === routineId) return;
    if (drafting) {
      loadedRoutineId.current = routineId;
      loadRoutineForm(emptyRoutineForm(currentUser));
      return;
    }
    if (!selectedRoutine) return;
    loadedRoutineId.current = routineId;
    loadRoutineForm(routineFormFor(selectedRoutine));
  }, [drafting, routineId, selectedRoutine]);

  function openRoutine(taskId: string) {
    setAssignmentFocus(false);
    onSelectRoutine(taskId);
  }

  function closeRoutine() {
    onSelectRoutine(null);
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
      if (form.id) {
        await updateTaskMutation.mutateAsync({ taskId: form.id, input: payload });
        /* Saved IS the new baseline: the record stays open, so the form has to
           stop reading as dirty the moment the write lands — otherwise the
           navigation guard would challenge the next click. */
        setFormBaseline(form);
      } else {
        const created = await createTaskMutation.mutateAsync(payload);
        // The draft became a record, so the address becomes the record's.
        const saved = { ...form, id: created.id };
        loadedRoutineId.current = created.id;
        setForm(saved);
        setFormBaseline(saved);
        onSelectRoutine(created.id);
      }
    } catch {
      // mutation onError surfaces a toast; keep the record open for retry.
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
      // Nothing left to show in the pane, so the board comes back. The
      // baseline is squared first, or leaving would ask about a deleted record.
      setFormBaseline(form);
      closeRoutine();
      announce({ message: t("routine.toast_deleted"), tone: "success" });
    } catch {
      // mutation onError surfaces a toast; keep the record open for retry.
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

  function startRoutine(task: RelayTaskListItem) {
    if (startInFlight.current) return;
    startInFlight.current = task.id;
    startTaskMutation.mutate(taskStartMutationInput(task), {
      onSettled: () => { startInFlight.current = null; },
    });
  }

  function startingRoutine(taskId: string): boolean {
    return startTaskMutation.isPending && startTaskMutation.variables?.taskId === taskId;
  }

  function startDisabledFor(task: RelayTaskListItem): boolean {
    return (!task.assignedAgentId && !task.assignedTeamId) || !task.routineEnabled;
  }

  function routineHandlers(task: RelayTaskListItem) {
    return {
      starting: startingRoutine(task.id),
      onEdit: () => openRoutine(task.id),
      // Quick-assign from a row: the same record, opened on its picker.
      onAssign: () => {
        setAssignmentFocus(true);
        onSelectRoutine(task.id);
      },
      onStart: () => startRoutine(task),
    };
  }

  const openSession = selectedRoutine ? linkedSession(selectedRoutine) : undefined;
  /* The table's header names what the rail's state select has narrowed to —
     the rail names the surface. */
  /* The rail already carries the board's count, and the table's own header
     would restate it whenever the filter bar is clear. It earns a number only
     once the bar has narrowed the set below what the rail shows. */
  const tableNarrowed = activeRoutineFilterCount(filters) > 0;
  const tableLabel = filters.state === "all"
    ? t("routine.all_states")
    : t(`routine.states.${filters.state}`);

  return (
    <section
      id="routine-panel"
      className="routine-page"
      data-view={routineId ? "detail" : "list"}
      aria-label={t("routine.title")}
      tabIndex={-1}
    >
      <RoutineRosterRail
        routines={filteredTasks}
        stateOf={stateOf}
        totalCount={routineTasks.length}
        selectedId={drafting ? null : routineId}
        query={filters.query}
        state={filters.state}
        onQueryChange={(query) => setFilters({ ...filters, query })}
        onStateChange={(state) => setFilters({ ...filters, state })}
        onSelect={openRoutine}
        onCreate={() => onSelectRoutine(NEW_ROUTINE_ID)}
      />

      <div className="routine-main">
        {routineId && form ? (
          <RoutineDetail
            key={routineId}
            form={form}
            task={selectedRoutine}
            state={selectedRoutine ? stateOf(selectedRoutine) : undefined}
            session={openSession}
            agentDisplayName={selectedRoutine ? taskAssignmentDisplay(selectedRoutine).name : undefined}
            logicalAgents={logicalAgents}
            teams={teams}
            saving={saving}
            deleting={deleting}
            starting={selectedRoutine ? startingRoutine(selectedRoutine.id) : false}
            startDisabled={selectedRoutine ? startDisabledFor(selectedRoutine) : true}
            initialFocus={assignmentFocus ? "assignment" : "title"}
            onChange={(next) => {
              if (next.variant === "routine") setForm(next);
            }}
            onSubmit={(event) => void submitRoutine(event)}
            onDelete={form.id ? () => { void deleteRoutine(); } : undefined}
            onStart={() => { if (selectedRoutine) startRoutine(selectedRoutine); }}
            onAssign={() => setAssignmentFocus(true)}
            onBack={closeRoutine}
            onOpenThread={onOpenThread}
          />
        ) : (
          <div className="routine-board">
            <PageHeader
              title={tableLabel}
              titleAs="h2"
              titleVariant="display"
              count={tableNarrowed ? t("routine.sub", { count: filteredTasks.length }) : undefined}
              actions={
                <TaskBoardHeaderActions
                  refreshLabel={t("nav.refresh")}
                  createLabel={t("routine.new")}
                  isRefreshing={isRefreshing}
                  onRefresh={() => void onRefresh()}
                  onCreate={() => onSelectRoutine(NEW_ROUTINE_ID)}
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
                onCreate={routineTasks.length === 0 ? () => onSelectRoutine(NEW_ROUTINE_ID) : undefined}
              />
            ) : (
              <>
                {/* One table, one header, no bands: the rail beside it has
                    already said which schedule state is on screen.

                    `data-density="compact"` is the same scope the backlog list
                    opts into — the two lists are one record grammar. */}
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
                  <Table className="routine-rows-body" aria-label={tableLabel}>
                    {pagedTasks.items.map((task) => {
                      const assignment = taskAssignmentDisplay(task);
                      return (
                        <RoutineRow
                          key={task.id}
                          task={task}
                          selected={visibleSelection.has(task.id)}
                          onToggleSelect={() => setSelection((current) => toggleSelected(current, task.id))}
                          state={stateOf(task)}
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
                <Pagination page={pagedTasks} onPageChange={setPage} label={tableLabel} />
              </>
            )}

            <TaskSelectionBar
              count={visibleSelection.size}
              deleting={deletingSelection}
              deleteLabel={t("routine.delete_selected")}
              onDelete={() => { void deleteSelectedRoutines(); }}
              onClear={() => setSelection(EMPTY_TASK_SELECTION)}
            />
          </div>
        )}
      </div>
    </section>
  );
}
