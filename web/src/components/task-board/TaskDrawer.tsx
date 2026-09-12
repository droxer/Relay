"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AgentTeam, EmployeeAgent, TaskPriority, TaskRoutineCadence, TaskRoutineType, TaskStatus } from "../../types";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../lib/backlog";
import { TASK_ROUTINE_CADENCES, TASK_ROUTINE_TYPES, isoToday } from "../../lib/routine";
import { assignmentOptionVisible } from "../../lib/taskAssignment";
import {
  clearTaskAssignment,
  nextRoutineRunDate,
  taskAssignmentValue,
  teamAssignmentPatch,
  type BacklogTaskFormState,
  type RoutineTaskFormState,
  type TaskBoardFormState,
} from "../../lib/taskBoardForm";
import { Drawer } from "@/components/ui/Drawer";
import { TaskDrawerArtifacts } from "./TaskDrawerArtifacts";
import { TaskDrawerWorkspace } from "./TaskDrawerWorkspace";
import { TaskDrawerHistory } from "./TaskDrawerHistory";
import { RoutineRunLedger } from "./RoutineRunLedger";
import { TaskResultSummary } from "./TaskResultSummary";
import {
  AssignmentField,
  type AgentView,
  type TeamView,
} from "../assignment/AssignmentField";

type TaskDrawerProps = {
  open: boolean;
  form: TaskBoardFormState;
  logicalAgents: EmployeeAgent[];
  teams?: AgentTeam[];
  saving: boolean;
  title: string;
  subtitle: string;
  deleting?: boolean;
  /** Field that receives focus when the drawer opens. Quick-assign actions pass "assignment". */
  initialFocus?: "title" | "assignment";
  onClose: () => void;
  onChange: (next: TaskBoardFormState) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete?: () => void;
  /** Fires after the drawer's exit animation completes — release form state here. */
  onClosed?: () => void;
  /** Read-only context (status, linked thread, recent activity) shown above the form in edit mode. */
  meta?: ReactNode;
  /** Opens a thread in place from the run history; falls back to plain navigation. */
  onOpenThread?: (sessionId: string) => void;
};

function BacklogFields({ form, onChange }: { form: BacklogTaskFormState; onChange: (next: TaskBoardFormState) => void }) {
  const { t } = useTranslation();
  const statusLabelId = useId();
  return (
    <>
      <Field label={t("backlog.status")} labelId={statusLabelId} wrapper="div">
        <Select
          value={form.status}
          onValueChange={(value) => {
            if (value == null) return
            onChange({ ...form, status: value as TaskStatus })
          }}
        >
          <SelectTrigger className="w-full" aria-labelledby={statusLabelId}>
            <SelectValue>{(value: TaskStatus) => t(`backlog.statuses.${value}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TASK_STATUSES.map((status) => (
              <SelectItem key={status} value={status} label={t(`backlog.statuses.${status}`)}>{t(`backlog.statuses.${status}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("backlog.due")}>
        <Input
          name="backlog-due-date"
          type="date"
          value={form.dueDate}
          onChange={(event) => onChange({ ...form, dueDate: event.target.value })}
        />
      </Field>
    </>
  );
}

function RoutineFields({ form, onChange }: { form: RoutineTaskFormState; onChange: (next: TaskBoardFormState) => void }) {
  const { t } = useTranslation();
  const typeLabelId = useId();
  const cadenceLabelId = useId();
  return (
    <>
      <Field label={t("routine.type")} labelId={typeLabelId} wrapper="div">
        <Select
          value={form.routineType}
          onValueChange={(value) => {
            if (value == null) return
            onChange({ ...form, routineType: value as TaskRoutineType })
          }}
        >
          <SelectTrigger className="w-full" aria-labelledby={typeLabelId}>
            <SelectValue>{(value: TaskRoutineType) => t(`routine.types.${value}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TASK_ROUTINE_TYPES.map((type) => (
              <SelectItem key={type} value={type} label={t(`routine.types.${type}`)}>{t(`routine.types.${type}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("routine.cadence")} labelId={cadenceLabelId} wrapper="div">
        <Select
          value={form.routineCadence}
          onValueChange={(value) => {
            if (value == null) return
            const routineCadence = value as TaskRoutineCadence;
            onChange({
              ...form,
              routineCadence,
              routineNextRunDate: routineCadence === "custom"
                ? form.routineNextRunDate
                : nextRoutineRunDate(routineCadence),
            })
          }}
        >
          <SelectTrigger className="w-full" aria-labelledby={cadenceLabelId}>
            <SelectValue>{(value: TaskRoutineCadence) => t(`routine.cadences.${value}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TASK_ROUTINE_CADENCES.map((cadence) => (
              <SelectItem key={cadence} value={cadence} label={t(`routine.cadences.${cadence}`)}>{t(`routine.cadences.${cadence}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("routine.next_run")}
        hint={t("routine.next_run_hint")}
        className="task-drawer-next-run"
      >
        <Input
          name={`${form.variant}-next-run-date`}
          type="date"
          min={isoToday()}
          required={form.routineCadence === "custom" && form.routineEnabled}
          value={form.routineNextRunDate}
          readOnly={form.routineCadence !== "custom"}
          onChange={(event) => onChange({ ...form, routineNextRunDate: event.target.value })}
        />
      </Field>
    </>
  );
}

export function TaskDrawer({
  open,
  form,
  logicalAgents,
  teams = [],
  saving,
  title,
  subtitle,
  deleting = false,
  initialFocus = "title",
  onClose,
  onChange,
  onSubmit,
  onDelete,
  onClosed,
  meta,
  onOpenThread,
}: TaskDrawerProps) {
  const { t } = useTranslation();
  const priorityLabelId = useId();
  const fieldPrefix = form.variant;
  const assignmentFieldId = `${fieldPrefix}-assignment`;
  const assignmentSummaryId = `${fieldPrefix}-assignment-summary`;
  const busy = saving || deleting;
  const [titleError, setTitleError] = useState<string | null>(null);
  // The submit button names the action it performs, not a generic "Confirm".
  const submitLabel = form.id
    ? t(form.variant === "routine" ? "routine.save" : "backlog.save_task")
    : t(form.variant === "routine" ? "routine.create" : "backlog.create_task");

  function updateBase(patch: Partial<TaskBoardFormState>): void {
    onChange({ ...form, ...patch } as TaskBoardFormState);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!form.title.trim()) {
      setTitleError(t("admin.v2.chat_error_field_required", { field: t("backlog.title_field") }));
      // Move focus to the field at fault — the error is inline, but a reader
      // who submitted from the footer has to be taken back to it.
      event.currentTarget
        .querySelector<HTMLInputElement>(`[name="${fieldPrefix}-title"]`)
        ?.focus();
      return;
    }
    onSubmit(event);
  }

  const agentOptions = logicalAgents.filter((agent) => assignmentOptionVisible(
    agent.employeeId,
    form.assigneeEmployeeId,
    agent.id === form.assignedAgentId,
  ));
  const teamOptions = teams.filter((team) => assignmentOptionVisible(
    team.ownerEmployeeId,
    form.assigneeEmployeeId,
    team.id === form.assignedTeamId,
  ));
  const selectedAgent = agentOptions.find((agent) => agent.id === form.assignedAgentId);
  const selectedTeam = teamOptions.find((team) => team.id === form.assignedTeamId);

  // A saved task can reference an agent/team that has since been deleted or is
  // no longer in the fetched roster. Fall back to the executor kind the task
  // still carries so the trigger and summary render a named placeholder with
  // the right glyph, instead of leaking the raw `agent:<id>` value.
  const assignedTeamView: TeamView | undefined = form.assignedTeamId
    ? selectedTeam ?? { name: t("backlog.assignment_unavailable_team"), members: [], lead: null, enabled: false }
    : undefined;
  const assignedAgentView: AgentView | undefined = !assignedTeamView && form.assignedAgentId
    ? selectedAgent
      ?? (form.assignedAgent
        ? {
            displayName: t("backlog.assignment_unavailable_agent"),
            executorKind: form.assignedAgent,
            enabled: false,
            availability: "offline",
          }
        : undefined)
    : undefined;

  return (
    <Drawer
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      subtitle={subtitle}
      subtitleMono={Boolean(form.id)}
      width={form.variant === "routine" ? "routine" : "task"}
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      onClosed={onClosed}
    >
      <form className="adm-form task-board-drawer-form" onSubmit={handleSubmit} noValidate>
        {meta}
        <Field label={t("backlog.title_field")} error={titleError ?? undefined} errorId="task-drawer-title-error">
          <Input
            data-modal-initial-focus={initialFocus === "title" ? "" : undefined}
            name={`${fieldPrefix}-title`}
            autoComplete="off"
            required
            value={form.title}
            onChange={(event) => {
              updateBase({ title: event.target.value });
              if (titleError) setTitleError(null);
            }}
            aria-invalid={Boolean(titleError) || undefined}
            aria-describedby={titleError ? "task-drawer-title-error" : undefined}
          />
        </Field>
        <Field label={t("backlog.description")}>
          <Textarea
            name={`${fieldPrefix}-description`}
            autoComplete="off"
            value={form.description}
            rows={5}
            onChange={(event) => updateBase({ description: event.target.value })}
          />
        </Field>
        <div className="task-drawer-form-grid">
          {form.variant === "routine" ? <RoutineFields form={form} onChange={onChange} /> : null}
          {form.variant === "backlog" ? <BacklogFields form={form} onChange={onChange} /> : null}
          <Field label={t("backlog.priority")} labelId={priorityLabelId} wrapper="div">
            <Select
              value={form.priority}
              onValueChange={(value) => {
                if (value == null) return
                updateBase({ priority: value as TaskPriority })
              }}
            >
              <SelectTrigger className="w-full" aria-labelledby={priorityLabelId}>
                <SelectValue>{(value: TaskPriority) => t(`backlog.priorities.${value}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TASK_PRIORITIES.map((priority) => (
                  <SelectItem key={priority} value={priority} label={t(`backlog.priorities.${priority}`)}>{t(`backlog.priorities.${priority}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <AssignmentField
            fieldId={assignmentFieldId}
            summaryId={assignmentSummaryId}
            autoFocus={initialFocus === "assignment"}
            value={taskAssignmentValue(form)}
            agents={agentOptions}
            teams={teamOptions}
            selectedAgent={assignedAgentView}
            selectedTeam={assignedTeamView}
            emptyHint={t(form.variant === "backlog" ? "backlog.unassigned_backlog_hint" : "backlog.unassigned_routine_hint")}
            onSelect={(selection) => {
              if (selection.kind === "none") {
                onChange(clearTaskAssignment(form));
                return;
              }
              if (selection.kind === "agent") {
                const logicalAgent = logicalAgents.find((agent) => agent.id === selection.id);
                if (!logicalAgent) return;
                updateBase({
                  assignedAgent: logicalAgent.executorKind,
                  assignedAgentId: logicalAgent.id,
                  assignedTeamId: "",
                  assigneeEmployeeId: logicalAgent.employeeId,
                  ...(form.variant === "routine" ? { routineEnabled: true as const } : {}),
                });
                return;
              }
              const team = teams.find((candidate) => candidate.id === selection.id);
              if (team) {
                updateBase({
                  ...teamAssignmentPatch(team.id),
                  ...(form.variant === "routine" ? { routineEnabled: true as const } : {}),
                });
              }
            }}
          />
        </div>
        {form.variant === "routine" ? (
          <>
            <div className="routine-toggle">
              <span className="routine-toggle-text">
                <Label render={<span />}>{t("routine.enabled")}</Label>
                <span className="adm-form-hint">{t("routine.enabled_hint")}</span>
              </span>
              <Switch
                name={`${fieldPrefix}-enabled`}
                checked={form.routineEnabled}
                disabled={!form.assignedAgentId && !form.assignedTeamId && !form.routineEnabled}
                onCheckedChange={(checked) => onChange({ ...form, routineEnabled: checked })}
                aria-label={t("routine.enabled")}
              />
            </div>
          </>
        ) : null}
        {form.id ? (
          <>
            {/* Both variants roll artifacts up the same way: a routine's files
                come from its occurrences' sessions, resolved by the backend. */}
            {/* The outcome leads: a person opening a finished task wants to
                know how it came out before what it left behind. */}
            {form.variant === "routine" ? null : (
              <TaskResultSummary taskId={form.id} onOpenThread={onOpenThread} />
            )}
            <TaskDrawerArtifacts taskId={form.id} />
            {/* Files produced sit next to files indexed: the artifact list is
                the durable record, the workspace is what is there right now. */}
            <TaskDrawerWorkspace taskId={form.id} onOpenThread={onOpenThread} />
            {/* A routine's runs happen in its occurrences, so it reads as a
                ledger of runs; a plain task ran once and reads as a timeline. */}
            {form.variant === "routine" ? (
              <RoutineRunLedger taskId={form.id} onOpenThread={onOpenThread} />
            ) : (
              <TaskDrawerHistory taskId={form.id} onOpenThread={onOpenThread} />
            )}
          </>
        ) : null}
        <div className="adm-form-actions">
          {form.id && onDelete ? (
            <Button
              type="button"
              variant="destructive"
              size="cta"
              className="adm-form-actions-leading"
              onClick={onDelete}
              disabled={busy}
              loading={deleting}
            >
              {deleting
                ? t(form.variant === "routine" ? "routine.deleting" : "backlog.deleting")
                : t(form.variant === "routine" ? "routine.delete_task" : "backlog.delete_task")}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="cta" onClick={onClose} disabled={busy}>
            {t("dialog.cancel")}
          </Button>
          <Button type="submit" variant="default" size="cta" loading={saving} disabled={deleting}>
            {saving ? t("admin.saving") : submitLabel}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
