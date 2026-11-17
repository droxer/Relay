"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { saveWorkflow, deleteWorkflow } from "../../api";
import { useInvalidateWorkflows } from "../../hooks/useProjectWorkflows";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { AgentTeam, Workflow, ProjectRecord, UserAgent } from "../../types";
import {
  WORKFLOW_LIMITS,
  draftFromTeam,
  emptyWorkflowStep,
  enabledProjectAgentIds,
  moveWorkflowStep,
  replaceWorkflowStep,
  validateWorkflowDraft,
  workflowDraftChanged,
  workflowDraftValid,
  workflowInput,
  type WorkflowDraftErrors,
  type WorkflowTeamDraft,
} from "../../lib/workflowTeamDraft";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Drawer } from "@/components/ui/Drawer";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ActionAdd, AdminDelete, ICON } from "../icons";
import { WorkflowStepCard } from "./WorkflowStepCard";

type Props = {
  open: boolean;
  project?: ProjectRecord;
  team?: AgentTeam;
  /** Optional Project choices for a new Workflow; `project`
   *  is the first choice. Absent, the Workflow stays in `project`. */
  projects?: ProjectRecord[];
  /** Null creates an independent Workflow in the selected Project. */
  workflow: Workflow | null;
  teams: AgentTeam[];
  agents: UserAgent[];
  onClose: () => void;
};

export function WorkflowEditor(props: Props) {
  // Re-key per opening so a closed drawer never leaks its draft into the next.
  const [opening, setOpening] = useState({ open: props.open, generation: 0 });
  if (opening.open !== props.open) {
    setOpening({ open: props.open, generation: opening.generation + (props.open ? 1 : 0) });
  }
  return <WorkflowEditorBody key={`${props.workflow?.id ?? "new"}:${opening.generation}`} {...props} />;
}

function WorkflowEditorBody({ open, project: initialProject, team, projects, workflow, teams, agents, onClose }: Props) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const invalidate = useInvalidateWorkflows();
  const [projectId, setProjectId] = useState(initialProject?.id ?? "");
  const project = projects?.find(item => item.id === projectId) ?? initialProject;
  const pickProject = !workflow && (projects?.length ?? 0) > 1;
  const saveMutation = useMutation({ mutationFn: (input: Parameters<typeof saveWorkflow>[0]) => saveWorkflow(input, workflow?.id), onSuccess: invalidate });
  const deleteMutation = useMutation({ mutationFn: () => deleteWorkflow(workflow!.id), onSuccess: invalidate });
  const [failure, setFailure] = useState<string | null>(null);
  const allowedAgentIds = useMemo(() => (team ? team.memberAgentIds : project ? enabledProjectAgentIds(project) : []), [project, team]);
  const stepAgents = useMemo(() => {
    const allowed = new Set(allowedAgentIds);
    return agents.filter((agent) => allowed.has(agent.id) && agent.enabled && !agent.deletedAt);
  }, [agents, allowedAgentIds]);
  // A new workflow opens with one step owned by the Project lead; the person
  // names it and adds the rest.
  const [saved] = useState<WorkflowTeamDraft>(() => workflow
    ? draftFromTeam(workflow)
    : { name: "", steps: [emptyWorkflowStep([], stepAgents.find(agent => agent.id === (team?.leadAgentId ?? project?.leadAgentId))?.id ?? stepAgents[0]?.id ?? "")] });
  const [draft, setDraft] = useState<WorkflowTeamDraft>(saved);
  const [errors, setErrors] = useState<WorkflowDraftErrors | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const nameErrorId = useId();
  const stepsId = useId();
  const busy = saveMutation.isPending || deleteMutation.isPending;
  const dirty = workflowDraftChanged(draft, saved);
  const confirmDiscard = useUnsavedChangesGuard(open && dirty && !busy);
  const shown = errors ?? { fields: {} };
  const atLimit = draft.steps.length >= WORKFLOW_LIMITS.steps;

  function judge(next: WorkflowTeamDraft, allowed: string[]) {
    const result = validateWorkflowDraft(next, allowed);
    // Before Save, scope changes only surface assignment problems. Empty
    // names and instructions are expected while the person is composing.
    return submitted ? result : {
      fields: Object.fromEntries(Object.entries(result.fields)
        .filter(([, fields]) => fields.agentId)
        .map(([id, fields]) => [id, { agentId: fields.agentId }])),
    };
  }

  function update(next: WorkflowTeamDraft) {
    setDraft(next);
    // Clear shown assignment or submission errors as the person fixes them.
    if (errors) setErrors(judge(next, stepAgents.map(agent => agent.id)));
  }

  function focusStep(index: number) {
    // Keep keyboard focus with the card that moved, on its first live control.
    window.requestAnimationFrame(() => {
      listRef.current?.querySelectorAll<HTMLElement>(".workflow-step-card")[index]
        ?.querySelector<HTMLElement>(".workflow-step-actions button:not(:disabled)")?.focus();
    });
  }

  function addStep() {
    const previous = draft.steps.at(-1)?.agentId ?? stepAgents[0]?.id ?? "";
    update({ ...draft, steps: [...draft.steps, emptyWorkflowStep(draft.steps, previous)] });
  }

  async function requestClose() {
    if (busy) return;
    if (await confirmDiscard()) onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    const result = validateWorkflowDraft(draft, stepAgents.map(agent => agent.id));
    setErrors(result);
    if (!workflowDraftValid(result)) {
      if (result.name) nameRef.current?.focus();
      else listRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
      return;
    }
    const input = workflowInput(draft, project?.id ?? "", workflow?.enabled ?? true);
    try {
      await saveMutation.mutateAsync(team ? { ...input, projectId: null, ownerTeamId: team.id } : input);
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async function remove() {
    if (!workflow || busy) return;
    const accepted = await confirm({
      title: t("teams.delete_title", { name: workflow.name }),
      message: t("workflow.delete_message"),
      confirmLabel: t("workflow.delete"),
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await deleteMutation.mutateAsync();
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={team?.name ?? project?.name}
      title={workflow ? t("workflow.edit_title") : t("workflow.create_title")}
      subtitle={workflow?.name}
      width="task"
      closeLabel={t("admin.v2.close_drawer")}
      bodyClassName="adm-drawer-body--column"
    >
      <form className="workflow-editor" onSubmit={(event) => void submit(event)} noValidate>
        <p className="workflow-editor-lede">{t("workflow.editor_lede")}</p>
        {pickProject ? <Field label={t("workflow.project")} hint={t("workflow.project_hint")} wrapper="div">
          <Select value={projectId} disabled={busy} onValueChange={value => {
            if (!value || value === projectId) return;
            const next = projects!.find(item => item.id === value);
            if (!next) return;
            setProjectId(value);
            const allowed = enabledProjectAgentIds(next).filter(id => agents.some(agent => agent.id === id && agent.enabled && !agent.deletedAt));
            // Scope changes never silently change the person responsible.
            setErrors(judge(draft, allowed));
          }}>
            <SelectTrigger className="w-full" aria-label={t("workflow.project")}><SelectValue>{project?.name}</SelectValue></SelectTrigger>
            <SelectContent>{projects!.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field> : null}
        {failure ? <p role="alert" className="text-destructive">{failure}</p> : null}
        <Field label={t("workflow.team_name")} error={shown.name ? t(`workflow.error_${shown.name}`, { limit: WORKFLOW_LIMITS.name }) : undefined} errorId={nameErrorId}>
          <Input
            ref={nameRef}
            value={draft.name}
            maxLength={WORKFLOW_LIMITS.name}
            autoComplete="off"
            disabled={busy}
            data-modal-initial-focus
            onChange={(event) => update({ ...draft, name: event.target.value })}
            aria-invalid={Boolean(shown.name) || undefined}
            aria-describedby={shown.name ? nameErrorId : undefined}
          />
        </Field>

        <section className="workflow-editor-steps" aria-labelledby={`${stepsId}-title`}>
          <h3 id={`${stepsId}-title`} className="workflow-editor-steps-title">
            {t("workflow.steps")}
            <span className="tnum">{draft.steps.length}</span>
          </h3>
          {stepAgents.length === 0 ? <p className="project-empty-hint">{t("workflow.no_project_agents")}</p> : null}
          <ol ref={listRef} className="workflow-step-list">
            {draft.steps.map((step, index) => (
              <WorkflowStepCard
                key={step.id}
                step={step}
                index={index}
                count={draft.steps.length}
                agents={stepAgents}
                errors={shown.fields[step.id]}
                disabled={busy}
                onChange={(patch) => update({ ...draft, steps: replaceWorkflowStep(draft.steps, step.id, patch) })}
                onMove={(to) => {
                  update({ ...draft, steps: moveWorkflowStep(draft.steps, index, to) });
                  focusStep(to);
                }}
                onRemove={() => update({ ...draft, steps: draft.steps.filter((item) => item.id !== step.id) })}
              />
            ))}
          </ol>
          {shown.steps ? (
            <p role="alert" className="text-destructive">
              {t(`workflow.error_steps_${shown.steps}`, { max: WORKFLOW_LIMITS.steps })}
            </p>
          ) : null}
          <div className="workflow-editor-add">
            <Button type="button" variant="outline" size="dense" disabled={busy || atLimit} onClick={addStep}>
              <ActionAdd size={ICON.sm} aria-hidden="true" />
              {t("workflow.add_step")}
            </Button>
          </div>
        </section>

        <p className="workflow-editor-note">{t("workflow.snapshot_note")}</p>

        {workflow ? (
          <div className="adm-drawer-section">
            <h3 className="adm-drawer-section-title">{t("admin.v2.danger_zone")}</h3>
            {teams.some(team => team.defaultWorkflowId === workflow.id || team.projectWorkflowDefaults?.[workflow.projectId ?? ""] === workflow.id) ? <p className="workflow-editor-note">{t("workflow.default_in_use")}</p> : null}
            <div className="adm-drawer-section-actions">
              <Button type="button" variant="destructive" onClick={() => void remove()} disabled={busy || teams.some(team => team.defaultWorkflowId === workflow.id || team.projectWorkflowDefaults?.[workflow.projectId ?? ""] === workflow.id)}>
                <AdminDelete size={ICON.sm} aria-hidden="true" />
                {t("workflow.delete")}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={busy}>
            {t("dialog.cancel")}
          </Button>
          <Button size="cta" type="submit" loading={saveMutation.isPending} disabled={deleteMutation.isPending || !stepAgents.length}>
            {t("workflow.save")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
