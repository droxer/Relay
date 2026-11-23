"use client";

import { TriggerKindField, EventTriggerFields } from "./AutomationTriggerFields";
import { AutomationPauseBanner } from "./AutomationPauseBanner";
import { ScheduleFields } from "./ScheduleFields";
import { WebhookSecretPanel } from "./WebhookSecretPanel";
import { TaskTagsField } from "./TaskTagsField";
import { ConnectionGrantField } from "../connections/ConnectionGrantField";
import { validConnectionGrants } from "../../api-client/connections";
import { describeTrigger } from "../../lib/automationTrigger";
import { useSessionCapabilities } from "../../hooks/useSessionCapabilities";
import { isSubmitChord, submitShortcutLabel } from "../../lib/shortcuts";
import { DatePicker } from "@/components/ui/date-picker";
import { ProjectWorkflowSelect } from "../workflow/ProjectWorkflowSelect";
import { useProjectWorkflowChoices } from "../../hooks/useProjectWorkflows";
import { WorkflowSelect } from "../workflow/WorkflowSelect";
import { workflowSelectionIssue } from "../../lib/workflowSelection";
import { useKeyChange } from "../../hooks/useKeyChange";
import { AssignmentKindSwitch, type AssignmentKind } from "./AssignmentKindSwitch";
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Textarea } from "@/components/ui/textarea";
import type { AgentTeam, UserAgent, ProjectListItem, RoutineTrigger, TaskPriority, TaskStatus } from "../../types";
import { TASK_PRIORITIES } from "../../lib/backlog";
import { NEW_TASK_STATUSES } from "../../lib/taskFlow";
import { taskAssignmentOptions } from "../../lib/taskAssignment";
import {
  NEW_TASK_ACCEPTANCE_POLICY,
  clearTaskAssignment,
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
  logicalAgents: UserAgent[];
  teams?: AgentTeam[];
  projects?: ProjectListItem[];
  /** Every tag already in use on the page, offered while typing one. */
  tagSuggestions?: readonly string[];
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
   * How the project field behaves. `required` (the default for a new issue)
   * insists on one; `optional` (the default for a new automation) also offers
   * "No project" — for an issue that means intake, which cannot take an agent
   * or run until triage moves it into a project;
   * `locked` (the default once saved) only names it, because a project is
   * where work runs and moving run work would strand its thread.
   */
  projectChoice?: "required" | "optional" | "locked";
};

/**
 * Whether choosing an agent or team turns the automation on. A Relay pause
 * stays put — re-pointing a runaway or failing automation must not re-arm
 * it — unless the pause was for having no target, which this choice fixes.
 */
function activatesOnAssign(form: TaskBoardFormState): boolean {
  if (form.variant !== "routine") return false;
  return form.routineState !== "paused_by_relay" || form.routinePauseReason === "no_target";
}

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
      {/* A new task picks where it starts; after that, status changes through
          the task's status control, the same one the list and board use. */}
      {form.id ? null : (
      <Field label={t("backlog.status")} labelId={statusLabelId} hint={t("backlog.ready_policy")} wrapper="div">
        <ChoiceGroup<TaskStatus>
          name="backlog-status"
          aria-labelledby={statusLabelId}
          value={form.status}
          onValueChange={(status) => onChange({ ...form, status })}
          options={NEW_TASK_STATUSES.map((status) => ({
            value: status,
            label: t(`backlog.statuses.${status}`),
            /* Intake keeps Ready on screen but unavailable, so the reader sees
               the step a project would unlock rather than a lone segment. */
            disabled: !canRun && status === "assigned" && status !== form.status,
          }))}
        />
      </Field>
      )}
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
  logicalAgents: UserAgent[]; teams: AgentTeam[]; projects: ProjectListItem[];
}) {
  const { t } = useTranslation();
  const enabledHintId = useId();
  const { automationTriggers } = useSessionCapabilities();
  const active = form.routineState === "active";
  // Nothing to run it on yet: the switch cannot turn on, and says why.
  const cannotEnable = !form.projectId && !form.assignedAgentId && !form.assignedTeamId && !active;
  const triggers = form.routineTriggers;
  const setTriggers = (routineTriggers: RoutineTrigger[]) => onChange({ ...form, routineTriggers });
  const setOnly = (trigger: RoutineTrigger) => setTriggers([trigger]);
  const [trigger] = triggers;
  return (
    <fieldset className="adm-form-section">
      <legend className="adm-form-legend">{t("routine.schedule")}</legend>
      {triggers.length > 1 ? (
        /* Several triggers come from the API; this form edits one. They are
           listed and saved back untouched rather than silently cut to one. */
        <div className="task-drawer-form-grid">
          <ul className="trigger-filters-wide">
            {triggers.map((item, index) => <li key={index}>{describeTrigger(item, t)}</li>)}
          </ul>
          <p className="adm-form-hint trigger-filters-wide">{t("automation.multi_trigger_readonly")}</p>
        </div>
      ) : (
        <div className="task-drawer-form-grid">
          {/* What starts it comes first: every field below depends on it. */}
          <TriggerKindField triggers={triggers} triggersEnabled={automationTriggers} onChange={setTriggers} />
          {trigger?.kind === "schedule" ? (
            <ScheduleFields schedule={trigger.schedule} onChange={(schedule) => setOnly({ kind: "schedule", schedule })} />
          ) : null}
          {trigger ? (
            <EventTriggerFields trigger={trigger} agents={logicalAgents} teams={teams} projects={projects} onChange={setOnly} />
          ) : null}
          {trigger?.kind === "webhook" ? <WebhookSecretPanel key={form.id ?? "new"} taskId={form.id} /> : null}
          {!trigger ? <p className="adm-form-hint">{t("automation.manual_hint")}</p> : null}
        </div>
      )}
      <AutomationPauseBanner task={form} />
      {/* A new automation with nothing to run on has no switch to offer: the
          assignment above already says what it needs, and choosing a target
          turns it on (activatesOnAssign). */}
      {!form.id && cannotEnable ? null : <div className="routine-toggle">
        <span className="routine-toggle-text">
          <Label render={<span />}>{t("routine.enabled")}</Label>
          <span className="adm-form-hint" id={enabledHintId}>
            {t(cannotEnable ? "routine.enabled_needs_target" : "routine.enabled_hint")}
          </span>
        </span>
        <Switch
          name={`${form.variant}-enabled`}
          checked={active}
          disabled={cannotEnable}
          /* Turning it on is also how an owner resumes a Relay pause. */
          onCheckedChange={(checked) => onChange({ ...form, routineState: checked ? "active" : "paused" })}
          aria-label={t("routine.enabled")}
          aria-describedby={enabledHintId}
        />
      </div>}
    </fieldset>
  );
}

export function TaskDrawer({
  open,
  form,
  logicalAgents,
  teams = [],
  projects = [],
  tagSuggestions,
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
  // An automation need not belong to a project: without one, its runs share
  // the automation's own workspace.
  projectChoice = form.id ? "locked" : form.variant === "routine" ? "optional" : "required",
}: TaskDrawerProps) {
  const { t } = useTranslation();
  const priorityLabelId = useId();
  const fieldPrefix = form.variant;
  const acceptanceLabelId = useId();
  const permissionLabelId = useId();
  const permissionHintId = useId();
  const assignmentFieldId = `${fieldPrefix}-assignment`;
  const assignmentSummaryId = `${fieldPrefix}-assignment-summary`;
  const busy = saving || deleting;
  const project = projects.find((item) => item.id === form.projectId);
  /* What the reader chose to assign before choosing who. A saved agent or
     workflow decides it; with neither, the switch remembers the choice until
     the drawer opens on another record. */
  const [kindChoice, setKindChoice] = useState<AssignmentKind>("agent");
  const assignmentKind: AssignmentKind = form.assignedWorkflowId && !form.assignedTeamId ? "workflow"
    : form.assignedAgentId || form.assignedTeamId ? "agent" : kindChoice;
  const workflowQuery = useProjectWorkflowChoices(project?.id, open && Boolean(project) && assignmentKind === "workflow");
  const availableProjects = projects.filter((item) => item.enabled && !item.archivedAt);
  const projectLabelId = useId();
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const [projectError, setProjectError] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  /* Settings that already carry a default fold away on a new record, with
     their current values in one line; a saved record opens on them, because
     changing one is the usual reason to edit. */
  const [moreOpen, setMoreOpen] = useState(Boolean(form.id));
  useKeyChange(`${open}:${form.id ?? ""}`, () => {
    setKindChoice("agent");
    setMoreOpen(Boolean(form.id));
  });
  const settingsSummary = [
    t((form.acceptancePolicy ?? NEW_TASK_ACCEPTANCE_POLICY) === "human" ? "backlog.acceptance_human" : "backlog.acceptance_automatic"),
    t(`backlog.priorities.${form.priority}`),
    t((form.permissionMode ?? "ask") === "ask" ? "backlog.permission_ask" : "backlog.permission_yolo"),
    ...(form.tags.length ? [t("backlog.more_options_tags", { count: form.tags.length })] : []),
  ].join(" · ");
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
    if (!validConnectionGrants(form.connectionGrants)) return;
    if (workflowIssue || (form.assignedAgentId && !selectedAgent)) return;
    onSubmit(event);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    const { key, metaKey, ctrlKey, altKey } = event;
    if (busy || !isSubmitChord({ key, metaKey, ctrlKey, altKey, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    event.currentTarget.requestSubmit();
  }

  const { agents: agentOptions, teams: teamOptions } = taskAssignmentOptions({
    project,
    computerId: form.computerId,
    agents: logicalAgents,
    teams,
    assigneeUserId: form.assigneeUserId,
    assignedAgentId: form.assignedAgentId,
    assignedTeamId: form.assignedTeamId,
    allowWorkflowSelection: true,
  });
  const selectedAgent = agentOptions.find((agent) => agent.id === form.assignedAgentId);
  /* Intake: an issue outside a project has nowhere to run, so it offers no
     agent or team — the server refuses one — only the way into a project. */
  const intake = form.variant === "backlog" && projectChoice !== "required" && !form.projectId && !form.computerId && !form.sourceRoutineId;
  const selectedTeam = teamOptions.find((team) => team.id === form.assignedTeamId);
  /* Project work runs with one Project Agent or one Project Workflow; teams
     are hidden there, so the switch is all that decides between the two. */
  const offersWorkflow = Boolean(project) && !intake && !form.assignedTeamId;
  const projectAgentIds = project?.members.filter(member => member.enabled).map(member => member.agentId);
  const teamWorkflowIssue = workflowSelectionIssue(selectedTeam,
    form.assignedWorkflowId || (form.collaborationStyle ? `preset:${form.collaborationStyle}` : null), project?.id, projectAgentIds);
  const independentWorkflow = workflowQuery.data?.workflows?.find(item => item.id === form.assignedWorkflowId);
  const workflowIssue = form.assignedTeamId ? (Boolean(project) || !selectedTeam || teamWorkflowIssue) : Boolean(form.assignedWorkflowId
    && (!project || !independentWorkflow?.enabled || independentWorkflow.projectId !== project?.id || workflowQuery.isError
      || !independentWorkflow.stepAgentIds.every(id => projectAgentIds?.includes(id))));


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

  const assignmentField = intake ? (
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
        hideTeams={Boolean(project)}
        selectedAgent={assignedAgentView}
        selectedTeam={assignedTeamView}
        emptyHint={t(form.variant === "backlog" ? "backlog.unassigned_backlog_hint" : "backlog.unassigned_routine_hint")}
        switcher={offersWorkflow ? (
          <AssignmentKindSwitch value={assignmentKind} disabled={saving} onChange={(kind) => {
            setKindChoice(kind);
            if (kind !== assignmentKind && (form.assignedAgentId || form.assignedTeamId || form.assignedWorkflowId)) {
              onChange(clearTaskAssignment(form));
            }
          }} />
        ) : undefined}
        alternate={offersWorkflow && assignmentKind === "workflow" ? (
          <ProjectWorkflowSelect triggerId={assignmentFieldId}
            workflows={(workflowQuery.data?.workflows ?? []).filter(item => item.projectId === project?.id && item.enabled && item.stepAgentIds.every(id => projectAgentIds?.includes(id)))}
            value={form.assignedWorkflowId || ""}
            onChange={id => updateBase({ assignedWorkflowId: id, assignedAgentId: "", assignedAgent: "", assignedTeamId: "", collaborationStyle: null })}
            disabled={saving} loading={workflowQuery.isPending} failed={workflowQuery.isError}
            issue={Boolean(workflowIssue)} onRetry={() => void workflowQuery.refetch()} />
        ) : undefined}
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
              assignedWorkflowId: "",
              // An ownerless agent says nothing about who the task is
              // for, so it leaves the assignee as the user chose it.
              assigneeUserId: logicalAgent.supervisorUserId ?? form.assigneeUserId,
              ...(activatesOnAssign(form) ? { routineState: "active" as const } : {}),
            });
            return;
          }
          const team = teams.find((candidate) => candidate.id === selection.id);
          if (team) {
            updateBase({
              ...teamAssignmentPatch(team.id),
              ...(activatesOnAssign(form) ? { routineState: "active" as const } : {}),
            });
          }
        }}
      />;

  const projectField = projectChoice !== "locked" ? (
    <Field
      label={t("project.project")}
      labelId={projectLabelId}
      wrapper="div"
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
      {!availableProjects.length && onCreateProject ? <Button type="button" variant="ghost" onClick={onCreateProject}>{t("project.create_action")}</Button> : null}
    </Field>
  ) : project ? (
    /* Locked once saved, but still a field: labelled like every other
       value in the form. */
    <Field label={t("project.projects")} hint={t("project.locked_hint")} wrapper="div">
      <p className="task-drawer-readonly-value">{project.name}</p>
    </Field>
  ) : null;

  return (
    <Drawer
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      /* A new record is named by its title alone; the section kicker and the
         "Draft" subtitle only repeat it. A saved one keeps both: its kicker
         places it and its subtitle is the reference number. */
      kicker={form.id ? t(form.variant === "routine" ? "nav.routine" : "nav.backlog") : undefined}
      title={title}
      subtitle={form.id ? subtitle : undefined}
      subtitleMono={Boolean(form.id)}
      width="task"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      onClosed={onClosed}
      layer={layer}
    >
      {/* Decisions first, in the order they depend on each other: what the
          work is, where it runs, who does it, then when — status and due for
          a task, the trigger for an automation. Settings that already carry a
          default follow under Details, so on a phone the form can be finished
          without scrolling past them. */}
      <form className="adm-form task-board-drawer-form" onSubmit={handleSubmit} onKeyDown={handleKeyDown} noValidate>
        <Field label={t("backlog.title_field")} error={titleError ?? undefined} errorId="task-drawer-title-error">
          <Input
            placeholder={t(form.variant === "routine" ? "routine.title_placeholder" : "backlog.title_placeholder")}
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
        <Field label={t("backlog.description")} optional={t("admin.v2.optional")}>
          <Textarea
            name={`${fieldPrefix}-description`}
            autoComplete="off"
            value={form.description}
            rows={3}
            onChange={(event) => updateBase({ description: event.target.value })}
          />
        </Field>
        {projectField}
        {assignmentField}
        {(form.assignedAgentId && !selectedAgent) || (form.assignedTeamId && !selectedTeam) ? <p role="alert" className="text-destructive">{t("backlog.assignment_reselect")}</p> : null}
        {/* Directly under the assignment that reveals it: picking a team
            below must not insert a field above where the reader is working. */}
        {selectedTeam ? <Field label={t("workflow.select_workflow")} wrapper="div">
          <WorkflowSelect team={selectedTeam} projectId={project?.id} projectAgentIds={projectAgentIds} restrictToProject predefinedOnly={!project} inherit disabled={saving}
            value={form.assignedWorkflowId || (form.collaborationStyle ? `preset:${form.collaborationStyle}` : null)}
            onChange={workflowId => onChange({ ...form, assignedWorkflowId: workflowId ?? "", collaborationStyle: null })} />
        </Field> : null}
        {form.variant === "backlog" ? (
          <div className={form.id ? undefined : "task-drawer-form-grid"}>
            <BacklogFields form={form} onChange={onChange} canRun={!intake} />
          </div>
        ) : null}
        {form.variant === "routine" ? <RoutineSchedule form={form} onChange={onChange} logicalAgents={logicalAgents} teams={teams} projects={projects} /> : null}
        <details
          className="task-drawer-more"
          open={moreOpen}
          onToggle={(event) => setMoreOpen(event.currentTarget.open)}
        >
          <summary>
            <span className="task-drawer-more-title">{t("backlog.more_options")}</span>
            {moreOpen ? null : <span className="task-drawer-more-status">{settingsSummary}</span>}
          </summary>
          <div className="task-drawer-more-body">
          {/* Two-up pairs only — acceptance with priority here, status with
              due above — so no field is ever left alone in half a row. */}
          <div className="task-drawer-form-grid">
            <Field
              label={t("backlog.acceptance_policy")}
              labelId={acceptanceLabelId}
              hint={form.startedAt ? t("backlog.acceptance_locked") : undefined}
              wrapper="div"
            >
              <ChoiceGroup<"human" | "automatic">
                name={`${fieldPrefix}-acceptance`}
                aria-labelledby={acceptanceLabelId}
                value={form.acceptancePolicy ?? NEW_TASK_ACCEPTANCE_POLICY}
                disabled={Boolean(form.startedAt)}
                onValueChange={(acceptancePolicy) => onChange({ ...form, acceptancePolicy })}
                options={[
                  { value: "human", label: t("backlog.acceptance_human") },
                  { value: "automatic", label: t("backlog.acceptance_automatic") },
                ]}
              />
            </Field>
            <Field label={t("backlog.priority")} labelId={priorityLabelId} wrapper="div">
              <ChoiceGroup<TaskPriority>
                name={`${fieldPrefix}-priority`}
                aria-labelledby={priorityLabelId}
                value={form.priority}
                onValueChange={(priority) => updateBase({ priority })}
                options={TASK_PRIORITIES.map((priority) => ({ value: priority, label: t(`backlog.priorities.${priority}`) }))}
              />
            </Field>
          </div>
          <Field
            label={t("backlog.permission_mode")}
            labelId={permissionLabelId}
            hint={<span id={permissionHintId}>{t("backlog.permission_mode_hint")}</span>}
            wrapper="div"
          >
            <ChoiceGroup<"ask" | "yolo">
              name={`${fieldPrefix}-permission`}
              aria-labelledby={permissionLabelId}
              aria-describedby={permissionHintId}
              value={form.permissionMode ?? "ask"}
              disabled={busy}
              onValueChange={(permissionMode) => updateBase({ permissionMode })}
              options={[
                { value: "ask", label: t("backlog.permission_ask") },
                { value: "yolo", label: t("backlog.permission_yolo") },
              ]}
            />
          </Field>
          <TaskTagsField
            name={`${fieldPrefix}-tags`}
            tags={form.tags}
            suggestions={tagSuggestions}
            disabled={busy}
            onChange={(tags) => updateBase({ tags })}
          />
          <ConnectionGrantField key={form.id ?? "new"} targetType={form.variant === "routine" ? "automation" : "task"}
            targetId={form.id} value={form.connectionGrants} disabled={saving || Boolean(form.sourceRoutineId)}
            mailOnly={!form.id && form.variant !== "routine"}
            onChange={connectionGrants => onChange({ ...form, connectionGrants })} />
          </div>
        </details>
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
          <Button type="submit" variant="default" size="cta" loading={saving} disabled={deleting || Boolean(workflowIssue)}>
            {saving ? t("admin.saving") : submitLabel}
          </Button>
          {/* Last in the DOM so the phone footer's odd-child rule still sees
              Cancel and Submit as its last pair; CSS moves it to the leading
              edge, on pointer devices only — a touch keyboard has no chord.
              A saved record's Delete owns that edge, so it shows none. */}
          {form.id && onDelete ? null : (
            <span className="task-drawer-shortcut" aria-hidden="true">
              <kbd className="command-kbd">{submitShortcutLabel()}</kbd> {t("backlog.submit_shortcut")}
            </span>
          )}
        </div>
      </form>
    </Drawer>
  );
}
