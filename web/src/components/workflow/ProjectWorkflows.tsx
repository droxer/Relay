"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { startProjectWorkflow } from "../../api";
import { useTeams } from "../../hooks/useTeams";
import { useProjectWorkflows } from "../../hooks/useProjectWorkflows";
import { workflowOptions } from "../../lib/workflowSelection";
import type { WorkflowPreview, AgentTeam, ProjectListItem, UserAgent } from "../../types";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Drawer } from "@/components/ui/Drawer";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ActionAdd, ActionStart, ICON } from "../icons";
import { WorkflowStepSummary } from "./WorkflowStepSummary";
import { WorkflowEditorForPreview } from "./WorkflowEditor";

type Props = {
  project: ProjectListItem;
  agents: UserAgent[];
  userId?: string;
  readOnly: boolean;
  onOpenThread: (sessionId: string) => void;
};

export function ProjectWorkflows({ project, agents, userId, readOnly, onOpenThread }: Props) {
  const { t } = useTranslation();
  const { teams } = useTeams(userId);
  const query = useProjectWorkflows(project.id);
  const workflows = useMemo(() => query.data?.workflows ?? [], [query.data]);
  const [editing, setEditing] = useState<{ workflow: WorkflowPreview | null } | null>(null);
  const [starting, setStarting] = useState<WorkflowPreview | null>(null);
  const canManage = Boolean(userId) && userId === project.ownerUserId && !readOnly;
  const canCreate = canManage && project.members.some(member => member.enabled);
  const agentName = (id: string) => agents.find(agent => agent.id === id)?.displayName ?? t("project.member_unavailable");
  const linkedTeams = (workflow: WorkflowPreview) => teams.filter(team => team.enabled && !team.deletedAt
    && workflowOptions(team).some(item => item.id === workflow.id)
    && workflow.workflowSteps.every(step => team.memberAgentIds.includes(step.agentId)));
  // Approvals are named only when there are some; "0 approvals" is noise.
  const processMeta = (workflow: WorkflowPreview) => {
    const gates = workflow.workflowSteps.filter(step => step.requiresApproval).length;
    const steps = t("workflow.step_count", { count: workflow.workflowSteps.length });
    return gates ? `${steps} · ${t("workflow.approval_count", { count: gates })}` : steps;
  };

  return <section className="project-general-section workflow-project-library" aria-labelledby="project-workflows-title">
    {/* The tab's lede already says what a workflow is; the head only counts. */}
    <div className="workflow-library-head">
      <h2 id="project-workflows-title" className="workspace-dossier-section-title">{t("workflow.section_title")} <span className="tnum">{workflows.length}</span></h2>
      {canManage ? <Button type="button" variant="default" size="dense" disabled={!canCreate} onClick={() => setEditing({ workflow: null })}>
        <ActionAdd size={ICON.sm} aria-hidden="true" />{t("workflow.create")}
      </Button> : null}
    </div>
    {canManage && !canCreate ? <p className="workflow-editor-note">{t("workflow.project_agents_needed")} <a className="record-inline-action" href={`/projects/${encodeURIComponent(project.id)}?tab=members`}>{t("workflow.manage_agents")}</a></p> : null}
    {query.isPending ? <p className="workflow-teams-state" aria-busy="true">{t("workflow.loading")}</p>
      : query.isError ? <div className="workflow-teams-state" role="alert"><p>{t("workflow.load_failed")}</p><Button type="button" variant="outline" size="dense" onClick={() => void query.refetch()}>{t("workspace.retry")}</Button></div>
      : workflows.length === 0 ? <div className="workflow-project-empty"><h3>{t("workflow.project_empty_title")}</h3><p>{t("workflow.project_empty_body")}</p></div>
      : <ul className="workflow-team-list">
        {workflows.map(workflow => {
          const availableTeams = linkedTeams(workflow);
          return <li key={workflow.id} className="workflow-team-row workflow-project-row" data-enabled={workflow.enabled}>
            <div className="workflow-project-row-head">
              <div className="workflow-library-main">
                <div className="workflow-team-row-name"><h3 className="workflow-library-name">{workflow.name}</h3>
                  {!workflow.enabled ? <span className="workflow-preview-kind">{t("teams.disabled")}</span> : null}
                </div>
                <p className="workflow-library-meta">{processMeta(workflow)}</p>
              </div>
              {canManage ? <div className="workflow-team-actions">
                <Button type="button" variant="ghost" size="dense" onClick={() => setEditing({ workflow })}>{t("workflow.edit")}</Button>
                <Button type="button" variant="outline" size="dense" disabled={!workflow.enabled} onClick={() => setStarting(workflow)}><ActionStart size={ICON.sm} aria-hidden="true" />{t("workflow.start")}</Button>
              </div> : null}
            </div>
            <WorkflowStepSummary steps={workflow.workflowSteps} label={t("workflow.steps_of", { name: workflow.name })} agentName={agentName} />
            {availableTeams.length ? <p className="workflow-library-meta">{t("workflow.optional_teams", { names: availableTeams.map(team => team.name).join(", ") })}</p> : null}
          </li>;
        })}
      </ul>}
    {canManage ? <>
      <WorkflowEditorForPreview open={editing !== null} project={project} workflow={editing?.workflow ?? null} teams={teams} agents={agents} onClose={() => setEditing(null)} />
      <WorkflowRunStarter key={starting?.id ?? "closed"} workflow={starting} teams={starting ? linkedTeams(starting) : []} project={project} onClose={() => setStarting(null)} onStarted={sid => { setStarting(null); onOpenThread(sid); }} />
    </> : null}
  </section>;
}

/** A UUID v4 for the start request. `randomUUID` needs a secure context; a
 *  backend served over plain HTTP on a LAN still has `getRandomValues`. */
function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Asks for the run's goal, then starts it. One request id per opening, so a
 *  resubmit after a dropped response returns the same Thread, not a second. */
function WorkflowRunStarter({
  workflow, project, teams, onClose, onStarted,
}: {
  workflow: WorkflowPreview | null;
  teams: AgentTeam[];
  project: ProjectListItem;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const [teamId, setTeamId] = useState("");
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ teamId: string | null; requestId: string }>(() => ({ teamId: null, requestId: newRequestId() }));
  if (workflow && opened.teamId !== workflow.id) {
    setOpened({ teamId: workflow.id, requestId: newRequestId() });
    setGoal("");
    setTeamId("");
    setFailure(null);
  }
  const firstGated = workflow?.workflowSteps?.[0]?.requiresApproval === true;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workflow || pending) return;
    if (!goal.trim()) {
      setFailure(t("workflow.goal_required"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const session = await startProjectWorkflow(workflow.id, { requestId: opened.requestId, taskGoal: goal.trim(), ...(teamId ? { teamId } : {}) });
      announce({ message: firstGated ? t("workflow.started_gated") : t("workflow.started"), tone: "success" });
      setOpened({ teamId: null, requestId: newRequestId() });
      onStarted(session.id);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Drawer
      open={workflow !== null}
      onClose={() => { if (!pending) onClose(); }}
      kicker={project.name}
      title={t("workflow.start_title")}
      subtitle={workflow?.name}
      width="form"
      closeLabel={t("admin.v2.close_drawer")}
      bodyClassName="adm-drawer-body--column"
    >
      <form className="workflow-editor" onSubmit={(event) => void submit(event)} noValidate>
        <Field label={t("workflow.optional_team")} wrapper="div" hint={t("workflow.independent_run_hint")}>
          <Select value={teamId || "independent"} disabled={pending} onValueChange={value => setTeamId(value === "independent" ? "" : value ?? "")}>
            <SelectTrigger className="w-full" aria-label={t("workflow.optional_team")}><SelectValue>{teamId ? teams.find(team => team.id === teamId)?.name : t("workflow.independent")}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="independent">{t("workflow.independent")}</SelectItem>{teams.map(team => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label={t("workflow.goal")} hint={t("workflow.goal_hint")} error={failure ?? undefined} errorId="workflow-run-goal-error">
          <Textarea
            rows={5}
            maxLength={20000}
            value={goal}
            disabled={pending}
            data-modal-initial-focus
            onChange={(event) => setGoal(event.target.value)}
            aria-invalid={Boolean(failure) || undefined}
            aria-describedby={failure ? "workflow-run-goal-error" : undefined}
          />
        </Field>
        {firstGated ? <p className="workflow-editor-note">{t("workflow.first_gate_note")}</p> : null}
        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={onClose} disabled={pending}>
            {t("dialog.cancel")}
          </Button>
          <Button size="cta" type="submit" loading={pending}>
            {t("workflow.start")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
