"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { startWorkflowRun } from "../../api";
import { useTeams } from "../../hooks/useTeams";
import { projectWorkflowTeams } from "../../lib/workflowTeamDraft";
import type { AgentTeam, ProjectRecord, UserAgent } from "../../types";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Drawer } from "@/components/ui/Drawer";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ActionAdd, ActionStart, ICON } from "../icons";
import { WorkflowStepSummary } from "./WorkflowStepSummary";
import { WorkflowTeamEditor } from "./WorkflowTeamEditor";

type Props = {
  project: ProjectRecord;
  agents: UserAgent[];
  /** The signed-in person; only the Project owner manages or runs workflows. */
  userId?: string;
  readOnly: boolean;
  onOpenThread: (sessionId: string) => void;
};

/** The Members tab's workflow section: Teams built from this Project's
 *  Agents as an ordered list of steps, created, edited and started here.
 *  Each run is a new Project Thread. */
export function ProjectWorkflowTeams({ project, agents, userId, readOnly, onOpenThread }: Props) {
  const { t } = useTranslation();
  const { teams, isSuccess, error, refetch } = useTeams(userId);
  const workflows = useMemo(() => projectWorkflowTeams(teams, project.id), [teams, project.id]);
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.displayName])), [agents]);
  const [editing, setEditing] = useState<{ team: AgentTeam | null } | null>(null);
  const [starting, setStarting] = useState<AgentTeam | null>(null);
  const canManage = Boolean(userId) && userId === project.ownerUserId && !readOnly;
  const canCreate = canManage && project.members.some((member) => member.enabled);

  let body;
  if (error && !isSuccess) {
    body = (
      <div className="workflow-teams-state" role="alert">
        <p>{t("workflow.load_failed")}</p>
        <Button type="button" variant="outline" size="dense" onClick={() => void refetch()}>{t("workspace.retry")}</Button>
      </div>
    );
  } else if (!isSuccess && userId) {
    body = <p className="workflow-teams-state" aria-busy="true">{t("workflow.loading")}</p>;
  } else if (workflows.length === 0) {
    body = <p className="workflow-teams-state">{canCreate ? t("workflow.empty") : t("workflow.empty_read_only")}</p>;
  } else {
    body = (
      <ul className="workflow-team-list">
        {workflows.map((team) => (
          <li key={team.id} className="workflow-team-row">
            <div className="workflow-team-main">
              <span className="workflow-team-name">{team.name}</span>
              <WorkflowStepSummary
                steps={team.workflowSteps ?? []}
                label={t("workflow.steps_of", { name: team.name })}
                agentName={(agentId) => agentNames.get(agentId) ?? t("project.member_unavailable")}
              />
            </div>
            {canManage ? (
              <div className="workflow-team-actions">
                <Button type="button" variant="ghost" size="dense" onClick={() => setEditing({ team })}>
                  {t("workflow.edit")}
                </Button>
                <Button type="button" variant="outline" size="dense" disabled={!team.enabled} onClick={() => setStarting(team)}>
                  <ActionStart size={ICON.sm} aria-hidden="true" />
                  {t("workflow.start")}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="project-general-section workflow-teams" aria-labelledby="project-workflows-title">
      <div className="project-general-section-head">
        <h2 id="project-workflows-title" className="workspace-dossier-section-title">
          {t("workflow.section_title")}
          <span className="tnum">{workflows.length}</span>
        </h2>
        {canCreate ? (
          <Button type="button" variant="outline" size="dense" onClick={() => setEditing({ team: null })}>
            <ActionAdd size={ICON.sm} aria-hidden="true" />
            {t("workflow.create")}
          </Button>
        ) : null}
      </div>
      {body}
      {canManage ? (
        <>
          <WorkflowTeamEditor
            open={editing !== null}
            project={project}
            team={editing?.team ?? null}
            agents={agents}
            onClose={() => setEditing(null)}
          />
          <WorkflowRunStarter
            team={starting}
            project={project}
            onClose={() => setStarting(null)}
            onStarted={(sessionId) => {
              setStarting(null);
              onOpenThread(sessionId);
            }}
          />
        </>
      ) : null}
    </section>
  );
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
  team, project, onClose, onStarted,
}: {
  team: AgentTeam | null;
  project: ProjectRecord;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ teamId: string | null; requestId: string }>(() => ({ teamId: null, requestId: newRequestId() }));
  if (team && opened.teamId !== team.id) {
    setOpened({ teamId: team.id, requestId: newRequestId() });
    setGoal("");
    setFailure(null);
  }
  const firstGated = team?.workflowSteps?.[0]?.requiresApproval === true;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!team || pending) return;
    if (!goal.trim()) {
      setFailure(t("workflow.goal_required"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const session = await startWorkflowRun(team.id, { requestId: opened.requestId, taskGoal: goal.trim() });
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
      open={team !== null}
      onClose={() => { if (!pending) onClose(); }}
      kicker={project.name}
      title={t("workflow.start_title")}
      subtitle={team?.name}
      width="form"
      closeLabel={t("admin.v2.close_drawer")}
      bodyClassName="adm-drawer-body--column"
    >
      <form className="workflow-editor" onSubmit={(event) => void submit(event)} noValidate>
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
