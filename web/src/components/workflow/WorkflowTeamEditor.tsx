"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { AgentTeam, ProjectRecord, UserAgent } from "../../types";
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
  workflowTeamInput,
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
  project: ProjectRecord;
  /** Null creates a workflow Team; a saved one edits its definition. */
  team: AgentTeam | null;
  agents: UserAgent[];
  onClose: () => void;
};

export function WorkflowTeamEditor(props: Props) {
  // Re-key per opening so a closed drawer never leaks its draft into the next.
  const [opening, setOpening] = useState({ open: props.open, generation: 0 });
  if (opening.open !== props.open) {
    setOpening({ open: props.open, generation: opening.generation + (props.open ? 1 : 0) });
  }
  return <WorkflowTeamEditorBody key={`${props.team?.id ?? "new"}:${opening.generation}`} {...props} />;
}

function WorkflowTeamEditorBody({ open, project, team, agents, onClose }: Props) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const { createTeamMutation, updateTeamMutation, deleteTeamMutation } = useRelayMutations();
  const allowedAgentIds = useMemo(() => enabledProjectAgentIds(project), [project]);
  const stepAgents = useMemo(() => {
    const allowed = new Set(allowedAgentIds);
    return agents.filter((agent) => allowed.has(agent.id) && !agent.deletedAt);
  }, [agents, allowedAgentIds]);
  // A new workflow opens with one step owned by the Project lead; the person
  // names it and adds the rest.
  const [saved] = useState<WorkflowTeamDraft>(() => team
    ? draftFromTeam(team)
    : { name: "", steps: [emptyWorkflowStep([], project.leadAgentId ?? stepAgents[0]?.id ?? "")] });
  const [draft, setDraft] = useState<WorkflowTeamDraft>(saved);
  const [errors, setErrors] = useState<WorkflowDraftErrors | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const nameErrorId = useId();
  const stepsId = useId();
  const busy = createTeamMutation.isPending || updateTeamMutation.isPending || deleteTeamMutation.isPending;
  const dirty = workflowDraftChanged(draft, saved);
  const confirmDiscard = useUnsavedChangesGuard(open && dirty && !busy);
  const shown = errors ?? { fields: {} };
  const atLimit = draft.steps.length >= WORKFLOW_LIMITS.steps;

  function update(next: WorkflowTeamDraft) {
    setDraft(next);
    // Re-judge only once a save has shown errors, so fixes clear them live.
    if (errors) setErrors(validateWorkflowDraft(next, allowedAgentIds));
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
    const result = validateWorkflowDraft(draft, allowedAgentIds);
    setErrors(result);
    if (!workflowDraftValid(result)) {
      if (result.name) nameRef.current?.focus();
      else listRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
      return;
    }
    const input = workflowTeamInput(draft, project, team?.enabled ?? true);
    try {
      if (team) await updateTeamMutation.mutateAsync({ teamId: team.id, input });
      else await createTeamMutation.mutateAsync(input);
      onClose();
    } catch {
      // The shared mutation handler announces the server's reason; the draft stays.
    }
  }

  async function remove() {
    if (!team || busy) return;
    const accepted = await confirm({
      title: t("teams.delete_title", { name: team.name }),
      message: t("workflow.delete_message"),
      confirmLabel: t("workflow.delete"),
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await deleteTeamMutation.mutateAsync(team.id);
      onClose();
    } catch {
      // Announced by the shared handler.
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={project.name}
      title={team ? t("workflow.edit_title") : t("workflow.create_title")}
      subtitle={team?.name}
      width="task"
      closeLabel={t("admin.v2.close_drawer")}
      bodyClassName="adm-drawer-body--column"
    >
      <form className="workflow-editor" onSubmit={(event) => void submit(event)} noValidate>
        <p className="workflow-editor-lede">{t("workflow.editor_lede")}</p>
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

        {team ? (
          <div className="adm-drawer-section">
            <h3 className="adm-drawer-section-title">{t("admin.v2.danger_zone")}</h3>
            <div className="adm-drawer-section-actions">
              <Button type="button" variant="destructive" onClick={() => void remove()} disabled={busy}>
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
          <Button size="cta" type="submit" loading={createTeamMutation.isPending || updateTeamMutation.isPending} disabled={deleteTeamMutation.isPending}>
            {t("workflow.save")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
