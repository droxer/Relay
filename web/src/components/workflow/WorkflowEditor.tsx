"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { saveWorkflow, deleteWorkflow, updateWorkflowDraft, type WorkflowSaveResponse } from "../../api";
import { RelayApiError } from "../../api-client/client";
import { useInvalidateWorkflows, useWorkflowRecord, workflowRecordIsOlder, WORKFLOWS_QUERY_KEY } from "../../hooks/useProjectWorkflows";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUnsavedChangesGuard } from "../../hooks/useUnsavedChangesGuard";
import type { AgentTeam, DaemonNodeMonitorRecord, Workflow, WorkflowPreview, ProjectListItem, UserAgent } from "../../types";
import { computerId as stableComputerId, computerName as stableComputerName } from "../../lib/createAgent";
import { agentOnComputer } from "../../lib/taskAssignment";
import {
  WORKFLOW_LIMITS,
  draftFromTeam,
  emptyWorkflowStep,
  enabledProjectAgentIds,
  moveWorkflowStep,
  replaceWorkflowStep,
  standaloneWorkflowInput,
  validateWorkflowDraft,
  workflowDraftPatch,
  workflowDraftUpdate,
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

export type WorkflowAgent = Pick<UserAgent, "id" | "displayName" | "profileImageUrl" | "executorKind" | "enabled" | "availability" | "deletedAt"> & {
  placements?: ReadonlyArray<{ computerId?: string; desiredState: string }>;
};

export type WorkflowComputer = Pick<DaemonNodeMonitorRecord, "id" | "displayName" | "retiredAt" | "userId" | "workspaceId" | "managedNodeId">;

type Props = {
  open: boolean;
  project?: ProjectListItem;
  team?: AgentTeam;
  /** Optional Project choices for a new Workflow; `project`
   *  is the first choice. Absent, the Workflow stays in `project`. */
  projects?: ProjectListItem[];
  /** Standalone Computer scope (mutually exclusive with `project`/`team`). */
  computerId?: string;
  /** Available Computers when creating or viewing a standalone Workflow. */
  computers?: readonly WorkflowComputer[];
  /** Null creates a new Workflow in the selected scope. */
  workflow: Workflow | null;
  teams: AgentTeam[];
  agents: readonly WorkflowAgent[];
  onClose: () => void;
  onDeleted?: () => void;
};

function isWorkflowDefinition(workflow: WorkflowPreview): workflow is Workflow {
  return workflow.workflowSteps.every(step => "instructions" in step && "acceptanceCriteria" in step);
}

export function WorkflowEditorForPreview({ workflow, ...props }: Omit<Props, "workflow"> & { workflow: WorkflowPreview | null }) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState({ open: props.open, workflow });
  // Keep the draft mounted if a background refresh advances the preview.
  if (opening.open !== props.open || opening.workflow?.id !== workflow?.id) {
    setOpening({ open: props.open, workflow });
  }
  const preview = opening.workflow;
  const definition = workflow && isWorkflowDefinition(workflow) ? workflow : null;
  const record = useWorkflowRecord(props.open && !definition ? preview : undefined);
  const saved = definition ?? record.data?.workflow;
  if (!props.open || !workflow || definition || (saved && preview && !workflowRecordIsOlder(saved, preview))) {
    return <WorkflowEditor {...props} workflow={workflow ? saved ?? null : null} />;
  }

  return <Drawer open onClose={props.onClose} title={t("workflow.edit_title")}
    subtitle={workflow.name} width="form" closeLabel={t("admin.v2.close_drawer")}>
    {record.isError ? <div role="alert">
      <p>{t("workflow.load_failed")}</p>
      <Button type="button" variant="outline" onClick={() => void record.refetch()}>{t("workspace.retry")}</Button>
    </div> : <p aria-busy="true">{t("workflow.loading")}</p>}
  </Drawer>;
}

export function WorkflowEditor(props: Props) {
  // Re-key per opening so a closed drawer never leaks its draft into the next.
  const [opening, setOpening] = useState({ open: props.open, generation: 0 });
  if (opening.open !== props.open) {
    setOpening({ open: props.open, generation: opening.generation + (props.open ? 1 : 0) });
  }
  return <WorkflowEditorBody key={`${props.workflow?.id ?? "new"}:${opening.generation}`} {...props} />;
}

function WorkflowEditorBody({ open, project: initialProject, team, projects, computerId: initialComputerId, computers, workflow, teams, agents, onClose, onDeleted }: Props) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWorkflows();
  const [projectId, setProjectId] = useState(initialProject?.id ?? "");
  const project = projects?.find(item => item.id === projectId) ?? initialProject;
  const pickProject = !workflow && (projects?.length ?? 0) > 1;
  const standaloneComputers = useMemo(
    () => (computers ?? []).filter((node) => !node.retiredAt),
    [computers],
  );
  const isStandalone = !team && !project && !pickProject && (Boolean(workflow?.computerId || initialComputerId) || computers !== undefined);
  const [selectedComputerId, setSelectedComputerId] = useState(
    () => workflow?.computerId ?? initialComputerId ?? (standaloneComputers[0] ? stableComputerId(standaloneComputers[0]) : ""),
  );
  const selectedComputer = standaloneComputers.find((node) => stableComputerId(node) === selectedComputerId);
  const pickComputer = isStandalone && !workflow && standaloneComputers.length > 1;
  const [originalWorkflow] = useState(workflow);
  const saveMutation = useMutation({
    mutationFn: (save: () => Promise<WorkflowSaveResponse>) => save(),
    onSuccess: data => invalidate(data, originalWorkflow),
  });
  const deleteMutation = useMutation({ mutationFn: () => deleteWorkflow(workflow!.id), onSuccess: () => invalidate() });
  const [failure, setFailure] = useState<string | null>(null);
  const allowedAgentIds = useMemo(() => {
    if (team) return team.memberAgentIds;
    if (project) return enabledProjectAgentIds(project);
    if (isStandalone && selectedComputerId) {
      return agents
        .filter((agent) => agent.enabled && !agent.deletedAt && agentOnComputer({ placements: agent.placements ?? [] }, selectedComputerId))
        .map((agent) => agent.id);
    }
    return [];
  }, [agents, isStandalone, project, selectedComputerId, team]);
  const stepAgents = useMemo(() => {
    const allowed = new Set(allowedAgentIds);
    return agents.filter((agent) => allowed.has(agent.id) && agent.enabled && !agent.deletedAt);
  }, [agents, allowedAgentIds]);
  // A new workflow opens with one step owned by the Project lead; the person
  // names it and adds the rest.
  const [saved] = useState<WorkflowTeamDraft>(() => originalWorkflow
    ? draftFromTeam(originalWorkflow)
    : { name: "", steps: [emptyWorkflowStep([], stepAgents.find(agent => agent.id === (team?.leadAgentId ?? project?.leadAgentId))?.id ?? stepAgents[0]?.id ?? "")] });
  const [draft, setDraft] = useState<WorkflowTeamDraft>(saved);
  const [errors, setErrors] = useState<WorkflowDraftErrors | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const formId = useId();
  const nameErrorId = useId();
  const stepsId = useId();
  const busy = saveMutation.isPending || deleteMutation.isPending;
  const changes = useMemo(() => workflowDraftUpdate(draft, saved), [draft, saved]);
  const dirty = Object.keys(changes).length > 0;
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
    setFailure(null);
    try {
      if (originalWorkflow) {
        if (dirty) {
          await saveMutation.mutateAsync(() => originalWorkflow.version === undefined
            ? saveWorkflow(workflowDraftPatch(draft, saved), originalWorkflow.id)
            : updateWorkflowDraft(originalWorkflow, changes));
        }
      } else if (isStandalone) {
        if (!selectedComputerId) {
          setFailure(t("workflows.no_computers"));
          return;
        }
        await saveMutation.mutateAsync(() => saveWorkflow(standaloneWorkflowInput(draft, selectedComputerId), undefined));
      } else {
        const input = workflowInput(draft, project?.id ?? "");
        await saveMutation.mutateAsync(() => saveWorkflow(team ? { ...input, projectId: null, ownerTeamId: team.id } : input, undefined));
      }
      onClose();
    } catch (error) {
      if (originalWorkflow && error instanceof RelayApiError && error.code === "workflow_version_conflict") {
        setFailure(t("workflow.version_conflict"));
        void queryClient.invalidateQueries({ queryKey: [WORKFLOWS_QUERY_KEY, "record", originalWorkflow.id], exact: true });
        return;
      }
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async function remove() {
    if (!workflow || busy) return;
    const accepted = await confirm({
      title: t("teams.delete_title", { name: workflow.name }),
      message: t(isStandalone ? "workflows.delete_message" : "workflow.delete_message"),
      confirmLabel: t("workflow.delete"),
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await deleteMutation.mutateAsync();
      onDeleted?.();
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }

  const computerLabel = selectedComputer ? stableComputerName(selectedComputer) : selectedComputerId || undefined;
  const defaultInUse = Boolean(workflow && !isStandalone && teams.some(
    (item) => item.defaultWorkflowId === workflow.id || item.projectWorkflowDefaults?.[workflow.projectId ?? ""] === workflow.id,
  ));

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={team?.name ?? project?.name ?? computerLabel}
      title={workflow ? t("workflow.edit_title") : t("workflow.create_title")}
      subtitle={workflow?.name}
      width="task"
      footer={
        <>
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={busy}>
            {t("dialog.cancel")}
          </Button>
          <Button size="cta" type="submit" form={formId} loading={saveMutation.isPending} disabled={deleteMutation.isPending || !stepAgents.length || (isStandalone && !selectedComputerId)}>
            {t("workflow.save")}
          </Button>
        </>
      }
    >
      <form id={formId} className="workflow-editor" onSubmit={(event) => void submit(event)} noValidate>
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
        {pickComputer ? <Field label={t("workflows.computer")} hint={t("workflows.computer_hint")} wrapper="div">
          <Select value={selectedComputerId} disabled={busy} onValueChange={value => {
            if (!value || value === selectedComputerId) return;
            setSelectedComputerId(value);
            const allowed = agents
              .filter((agent) => agent.enabled && !agent.deletedAt && agentOnComputer({ placements: agent.placements ?? [] }, value))
              .map((agent) => agent.id);
            setErrors(judge(draft, allowed));
          }}>
            <SelectTrigger className="w-full" aria-label={t("workflows.computer")}><SelectValue>{computerLabel}</SelectValue></SelectTrigger>
            <SelectContent>{standaloneComputers.map((node) => {
              const id = stableComputerId(node);
              return <SelectItem key={id} value={id}>{stableComputerName(node)}</SelectItem>;
            })}</SelectContent>
          </Select>
        </Field> : isStandalone && !workflow && standaloneComputers.length === 0 ? (
          <p className="project-empty-hint">{t("workflows.no_computers")}</p>
        ) : null}
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
          {stepAgents.length === 0 ? <p className="project-empty-hint">{t(isStandalone ? "workflows.no_computer_agents" : "workflow.no_project_agents")}</p> : null}
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
            {defaultInUse ? <p className="workflow-editor-note">{t("workflow.default_in_use")}</p> : null}
            <div className="adm-drawer-section-actions">
              <Button type="button" variant="destructive" onClick={() => void remove()} disabled={busy || defaultInUse}>
                <AdminDelete size={ICON.sm} aria-hidden="true" />
                {t("workflow.delete")}
              </Button>
            </div>
          </div>
        ) : null}
      </form>
    </Drawer>
  );
}
