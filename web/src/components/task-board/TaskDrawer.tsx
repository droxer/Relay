"use client";

import { TriggerKindField, EventTriggerFields } from "./AutomationTriggerFields";
import { WebhookSecretPanel } from "./WebhookSecretPanel";
import { DatePicker } from "@/components/ui/date-picker";
import { CollaborationStyleSelect } from "../CollaborationStyleSelect";
import { effectiveStyle } from "../../lib/collaborationStyle";
import { useId, useRef, useState, type FormEvent } from "react";
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
import type { AgentTeam, EmployeeAgent, ProjectRecord, TaskPriority, TaskRoutineCadence, TaskRoutineType, TaskStatus } from "../../types";
import { TASK_PRIORITIES } from "../../lib/backlog";
import { manualTaskStatuses } from "../../lib/taskFlow";
import { TASK_ROUTINE_CADENCES, TASK_ROUTINE_TYPES, isoToday } from "../../lib/routine";
import { taskAssignmentOptions } from "../../lib/taskAssignment";
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
  projects?: ProjectRecord[];
  onCreateProject?: () => void;
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
  /** Stacking order — 1 when the form opens above a record drawer. */
  layer?: number;
  /**
   * How the project field behaves. `required` (the default for a new record)
   * insists on one; `optional` also offers "No project" — an intake issue,
   * which cannot take an agent or run until triage moves it into a project;
   * `locked` (the default once saved) only names it, because a project is
   * where work runs and moving run work would strand its thread.
   */
  projectChoice?: "required" | "optional" | "locked";
};

/** The Select value that stands for "no project" — Select has no null item. */
const NO_PROJECT = "__none__";

function BacklogFields({ form, onChange, canRun }: {
  form: BacklogTaskFormState;
  onChange: (next: TaskBoardFormState) => void;
  /** False for intake: without a project there is no Ready to move to. */
  canRun: boolean;
}) {
  const { t } = useTranslation();
  const statusLabelId = useId();
  const dueLabelId = useId();
  return (
    <>
      <Field label={t("backlog.status")} labelId={statusLabelId} hint={t("backlog.ready_policy")} wrapper="div">
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
            {manualTaskStatuses(form.status, Boolean(form.startedAt))
              .filter((status) => canRun || status !== "assigned" || status === form.status)
              .map((status) => (
              <SelectItem key={status} value={status} label={t(`backlog.statuses.${status}`)}>{t(`backlog.statuses.${status}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("backlog.due")} wrapper="div" labelId={dueLabelId}>
        <DatePicker
          labelId={dueLabelId}
          name="backlog-due-date"
          value={form.dueDate}
          onValueChange={(dueDate) => onChange({ ...form, dueDate })}
        />
      </Field>
    </>
  );
}

/** Everything that decides when an automation runs: trigger, filters, and
 *  schedule controls, followed by its enabled switch. */
function RoutineSchedule({ form, onChange, logicalAgents, teams, projects }: {
  form: RoutineTaskFormState; onChange: (next: TaskBoardFormState) => void;
  logicalAgents: EmployeeAgent[]; teams: AgentTeam[]; projects: ProjectRecord[];
}) {
  const { t } = useTranslation();
  const typeLabelId = useId();
  const cadenceLabelId = useId();
  const nextRunLabelId = useId();
  const enabledHintId = useId();
  const autoNextRun = form.routineCadence !== "custom";
  // Nothing to run it on yet: the switch cannot turn on, and says why.
  const cannotEnable = !form.projectId && !form.assignedAgentId && !form.assignedTeamId && !form.routineEnabled;
  return (
    <fieldset className="adm-form-section">
      <legend className="adm-form-legend">{t("routine.schedule")}</legend>
      <div className="task-drawer-form-grid">
        {/* What starts it comes first: every field below depends on it. */}
        <TriggerKindField trigger={form.routineTrigger} onChange={(routineTrigger) => onChange({ ...form, routineTrigger })} />
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
        {form.routineTrigger.kind === "schedule" ? <>
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
            /* A cadence sets the date itself; say so, rather than leaving a
               field that looks editable and opens nothing. */
            hint={t(autoNextRun ? "routine.next_run_auto_hint" : "routine.next_run_hint")}
            className="task-drawer-next-run"
            wrapper="div"
            labelId={nextRunLabelId}
          >
            <DatePicker
              labelId={nextRunLabelId}
              name={`${form.variant}-next-run-date`}
              min={isoToday()}
              required={form.routineCadence === "custom" && form.routineEnabled}
              value={form.routineNextRunDate}
              readOnly={autoNextRun}
              onValueChange={(routineNextRunDate) => onChange({ ...form, routineNextRunDate })}
            />
          </Field>
        </> : null}
        <EventTriggerFields trigger={form.routineTrigger} agents={logicalAgents} teams={teams} projects={projects}
          onChange={(routineTrigger) => onChange({ ...form, routineTrigger })} />
        {form.routineTrigger.kind === "webhook" ? <WebhookSecretPanel key={form.id ?? "new"} taskId={form.id} /> : null}
        {form.routineTrigger.kind === "manual" ? <p className="adm-form-hint">{t("automation.manual_hint")}</p> : null}
      </div>
      <div className="routine-toggle">
        <span className="routine-toggle-text">
          <Label render={<span />}>{t("routine.enabled")}</Label>
          <span className="adm-form-hint" id={enabledHintId}>
            {t(!form.routineEnabled && form.routineDisabledReason === "rate_limited" ? "automation.rate_limited" : cannotEnable ? "routine.enabled_needs_target" : "routine.enabled_hint")}
          </span>
        </span>
        <Switch
          name={`${form.variant}-enabled`}
          checked={form.routineEnabled}
          disabled={cannotEnable}
          onCheckedChange={(checked) => onChange({ ...form, routineEnabled: checked })}
          aria-label={t("routine.enabled")}
          aria-describedby={enabledHintId}
        />
      </div>
    </fieldset>
  );
}

export function TaskDrawer({
  open,
  form,
  logicalAgents,
  teams = [],
  projects = [],
  onCreateProject,
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
  layer,
  projectChoice = form.id ? "locked" : "required",
}: TaskDrawerProps) {
  const { t } = useTranslation();
  const priorityLabelId = useId();
  const fieldPrefix = form.variant;
  const acceptanceLabelId = useId();
  const assignmentFieldId = `${fieldPrefix}-assignment`;
  const assignmentSummaryId = `${fieldPrefix}-assignment-summary`;
  const busy = saving || deleting;
  const project = projects.find((item) => item.id === form.projectId);
  const availableProjects = projects.filter((item) => item.enabled && !item.archivedAt);
  const projectLabelId = useId();
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const [projectError, setProjectError] = useState(false);
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
      setTitleError(t("backlog.title_required"));
      // Move focus to the field at fault — the error is inline, but a reader
      // who submitted from the footer has to be taken back to it.
      event.currentTarget
        .querySelector<HTMLInputElement>(`[name="${fieldPrefix}-title"]`)
        ?.focus();
      return;
    }
    if (projectChoice === "required" && (!project || !project.enabled || project.archivedAt)) {
      setProjectError(true);
      projectTriggerRef.current?.focus();
      return;
    }
    onSubmit(event);
  }

  const { agents: agentOptions, teams: teamOptions } = taskAssignmentOptions({
    project,
    agents: logicalAgents,
    teams,
    assigneeEmployeeId: form.assigneeEmployeeId,
    assignedAgentId: form.assignedAgentId,
    assignedTeamId: form.assignedTeamId,
  });
  const selectedAgent = agentOptions.find((agent) => agent.id === form.assignedAgentId);
  /* Intake: an issue outside a project has nowhere to run, so it offers no
     agent or team — the server refuses one — only the way into a project. */
  const intake = form.variant === "backlog" && projectChoice !== "required" && !form.projectId && !form.sourceRoutineId;
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
      width="task"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      onClosed={onClosed}
      layer={layer}
    >
      <form className="adm-form task-board-drawer-form" onSubmit={handleSubmit} noValidate>
        {projectChoice !== "locked" ? (
          <Field
            label={t("project.projects")}
            labelId={projectLabelId}
            wrapper="div"
            hint={projectChoice === "optional" ? t("issues.project_hint") : undefined}
            error={projectError ? t("project.required") : undefined}
          >
            <Select value={form.projectId || (projectChoice === "optional" ? NO_PROJECT : "")} onValueChange={(value) => {
              if (!value) return;
              const projectId = value === NO_PROJECT ? undefined : value;
              onChange({
                ...clearTaskAssignment(form),
                ...(form.variant === "backlog" ? { status: projectId || form.status !== "assigned" ? form.status : "backlog" } : {}),
                projectId,
              });
              setProjectError(false);
            }}>
              <SelectTrigger ref={projectTriggerRef} className="w-full" aria-labelledby={projectLabelId} aria-invalid={projectError || undefined}>
                <SelectValue>{() => project?.name ?? t(projectChoice === "optional" ? "issues.no_project" : "project.choose")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {projectChoice === "optional" ? <SelectItem value={NO_PROJECT}>{t("issues.no_project")}</SelectItem> : null}
                {availableProjects.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {!availableProjects.length && onCreateProject ? <Button type="button" variant="ghost" onClick={onCreateProject}>{t("project.create")}</Button> : null}
          </Field>
        ) : project ? (
          /* Locked once saved, but still a field: labelled like every other
             value in the form, not a stray line of grey text above the title. */
          <Field label={t("project.projects")} hint={t("project.locked_hint")} wrapper="div">
            <p className="task-drawer-readonly-value">{project.name}</p>
          </Field>
        ) : null}
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
        {/* Two-up pairs only — acceptance with priority, status with due — so
            no field is ever left alone in half a row. */}
        <div className="task-drawer-form-grid">
          <Field
            label={t("backlog.acceptance_policy")}
            labelId={acceptanceLabelId}
            hint={form.startedAt ? t("backlog.acceptance_locked") : undefined}
            wrapper="div"
          >
            <Select
              value={form.acceptancePolicy ?? "human"}
              disabled={Boolean(form.startedAt)}
              onValueChange={(value) => {
                if (value === "human" || value === "automatic") onChange({ ...form, acceptancePolicy: value });
              }}
            >
              <SelectTrigger className="w-full" aria-labelledby={acceptanceLabelId}>
                <SelectValue>{(value: string) => t(value === "automatic" ? "backlog.acceptance_automatic" : "backlog.acceptance_human")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="human">{t("backlog.acceptance_human")}</SelectItem>
                <SelectItem value="automatic">{t("backlog.acceptance_automatic")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
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
        </div>
        {form.variant === "backlog" ? (
          <div className="task-drawer-form-grid">
            <BacklogFields form={form} onChange={onChange} canRun={!intake} />
          </div>
        ) : null}
        {intake ? (
          <Field label={t("backlog.assignment_label")} wrapper="div">
            <p className="adm-form-hint" id={assignmentSummaryId}>{t("issues.assignment_needs_project")}</p>
            {form.assignedAgentId || form.assignedTeamId || form.assignedAgent ? (
              <Button type="button" variant="ghost" disabled={saving} onClick={() => onChange(clearTaskAssignment(form))}>
                {t("issues.clear_assignment")}
              </Button>
            ) : null}
          </Field>
        ) : <AssignmentField
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
                // An ownerless agent says nothing about who the task is
                // for, so it leaves the assignee as the employee chose it.
                assigneeEmployeeId: logicalAgent.supervisorEmployeeId ?? form.assigneeEmployeeId,
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
        />}
        {/* Directly under the assignment that reveals it: picking a team
            below must not insert a field above where the reader is working. */}
        {form.assignedTeamId ? <Field label={t("collab_style.task_label")} wrapper="div">
          <CollaborationStyleSelect aria-label={t("collab_style.task_label")} value={form.collaborationStyle ?? null}
            disabled={saving} onChange={(collaborationStyle) => onChange({ ...form, collaborationStyle })}
            inheritStyle={effectiveStyle(teams.find((team) => team.id === form.assignedTeamId))}
            inheritLabel={t("collab_style.team_default", { style: t(`collab_style.${effectiveStyle(teams.find((team) => team.id === form.assignedTeamId))}`) })} />
        </Field> : null}
        {form.variant === "routine" ? <RoutineSchedule form={form} onChange={onChange} logicalAgents={logicalAgents} teams={teams} projects={projects} /> : null}
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
