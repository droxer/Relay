"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { linkTeamWorkflow, setTeamDefaultWorkflow, setTeamProjectWorkflow, type TeamWorkflowWriteResponse } from "../../api";
import { syncTeamWorkflowUpdate, useTeamWorkflowChoices } from "../../hooks/useProjectWorkflows";
import { teamRecordKey, TEAMS_QUERY_KEY } from "../../hooks/useTeams";
import { defaultWorkflowId, PREDEFINED_WORKFLOWS, RETIRED_WORKFLOW_ID, teamWorkflowPreviews } from "../../lib/workflowSelection";
import type { AgentTeam } from "../../types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PredefinedWorkflowIcon } from "./PredefinedWorkflowIcon";
import { WorkflowEditorForPreview, type WorkflowAgent } from "./WorkflowEditor";
import type { WorkflowPreview } from "../../types";
import { WorkflowStepSummary } from "./WorkflowStepSummary";
import { workflowProcessMeta } from "./processMeta";
import { ActionAdd, ICON, NavProjects } from "../icons";

/** Teams reference Project processes; definitions survive unassignment. */
export function TeamWorkflowLibrary({ team, agents, userId }: { team: AgentTeam; agents: readonly WorkflowAgent[]; userId?: string }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [editing, setEditing] = useState<{ workflow: WorkflowPreview | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const canManage = Boolean(userId) && userId === team.ownerUserId;
  const catalog = useTeamWorkflowChoices(team, canManage);
  const projectNames = new Map(catalog.data?.projects.map(project => [project.id, project.name]));
  const loading = canManage && catalog.isPending;
  const loadFailed = canManage && catalog.isError;
  const custom = teamWorkflowPreviews(team);
  const available = (catalog.data?.workflows ?? []).filter(workflow => !custom.some(item => item.id === workflow.id));
  const change = useMutation({
    mutationFn: (action: () => Promise<TeamWorkflowWriteResponse>) => action(),
    onSuccess: async (result) => {
      if (result && "teamWorkflowUpdate" in result) {
        await syncTeamWorkflowUpdate(client, userId, team.id, result.teamWorkflowUpdate);
        return;
      }
      const key = teamRecordKey(userId, team.id);
      if (result?.team?.workflowPreviews) {
        await client.cancelQueries({ queryKey: key, exact: true });
        client.setQueryData(key, result);
      } else {
        await client.invalidateQueries({ queryKey: key });
      }
      await client.invalidateQueries({ queryKey: [TEAMS_QUERY_KEY, userId] });
    },
    onError: error => setFailure(error instanceof Error ? error.message : String(error)),
  });
  function apply(action: () => Promise<TeamWorkflowWriteResponse>) {
    setFailure(null);
    change.mutate(action);
  }
  const badge = (label: string) => <span className="workflow-preview-kind">{label}</span>;

  return <section className="collab-style-section workflow-library" aria-labelledby="team-workflows">
    <div className="workflow-library-head">
      <h2 id="team-workflows" className="workspace-dossier-section-title">{t("workflow.section_title")} <span className="tnum">{PREDEFINED_WORKFLOWS.length + custom.length}</span></h2>
      {/* One cluster on the trailing edge, like the Members head's Edit
          button: neither control floats between the title and the edge. */}
      {canManage ? <div className="workflow-library-actions">
        {available.length > 0 ? (
          <Select value="" disabled={change.isPending} onValueChange={id => { if (id) apply(() => linkTeamWorkflow(team.id, id)); }}>
            <SelectTrigger size="sm" className="w-auto" aria-label={t("workflow.assign_workflow")}><SelectValue>{t("workflow.assign_workflow")}</SelectValue></SelectTrigger>
            <SelectContent>{available.map(workflow => <SelectItem key={workflow.id} value={workflow.id}>{workflow.name} · {projectNames.get(workflow.projectId)}</SelectItem>)}</SelectContent>
          </Select>
        ) : null}
        <Button type="button" variant="default" size="sm" onClick={() => setEditing({ workflow: null })}><ActionAdd size={ICON.sm} aria-hidden="true" />{t("workflow.create")}</Button>
      </div> : null}
    </div>
    <p className="workflow-editor-note">{t("workflow.team_reference_hint")}</p>
    {defaultWorkflowId(team) === RETIRED_WORKFLOW_ID ? <p className="workflow-editor-note">{t("workflow.workflow_retired")}</p> : null}
    {failure ? <p role="alert" className="workflow-teams-state text-destructive">{failure}</p> : null}
    {loading ? <p className="workflow-teams-state" aria-busy="true">{t("workflow.loading")}</p> : null}
    {loadFailed ? <div className="workflow-teams-state" role="alert"><p>{t("workflow.load_failed")}</p><Button type="button" variant="outline" size="dense" onClick={() => void catalog.refetch()}>{t("workspace.retry")}</Button></div> : null}
    <ul className="workflow-team-list">
      {/* The glyph marks a predefined row and the step flow a custom one, so
          neither needs a kind chip; only the default is called out. */}
      {PREDEFINED_WORKFLOWS.map(style => <li key={style} className="workflow-team-row" data-kind="predefined">
        <span className="workflow-library-main"><span className="workflow-team-row-name"><PredefinedWorkflowIcon style={style} /><span className="workflow-library-name">{t(`collab_style.${style}`)}</span>
          {defaultWorkflowId(team) === `preset:${style}` ? badge(t("workflow.default_badge")) : null}</span><span className="workflow-library-meta">{t(`collab_style.${style}_hint`)}</span></span>
        {canManage && defaultWorkflowId(team) !== `preset:${style}` ? <div className="workflow-team-actions"><Button type="button" variant="ghost" size="dense" disabled={change.isPending}
          onClick={() => apply(() => setTeamDefaultWorkflow(team.id, `preset:${style}`))}>{t("workflow.set_default")}</Button></div> : null}
      </li>)}
      {custom.map(workflow => {
        const projectName = workflow.projectId ? projectNames.get(workflow.projectId) : undefined;
        const isDefault = team.projectWorkflowDefaults?.[workflow.projectId ?? ""] === workflow.id || team.defaultWorkflowId === workflow.id;
        const projectUrl = `/projects/${encodeURIComponent(workflow.projectId ?? "")}?tab=members`;
        const projectOwned = !workflow.ownerTeamId && Boolean(workflow.projectId);
        return <li key={workflow.id} className="workflow-team-row workflow-project-row" data-kind="steps">
          <div className="workflow-project-row-head">
            <div className="workflow-library-main">
              <span className="workflow-team-row-name"><span className="workflow-library-name">{workflow.name}</span>{badge(t(workflow.ownerTeamId ? "workflow.team_owned" : "workflow.project_owned"))}{isDefault ? badge(t(workflow.ownerTeamId ? "workflow.default_badge" : "workflow.project_default")) : null}{!workflow.enabled ? badge(t("teams.disabled")) : null}</span>
              <span className="workflow-library-meta">{workflowProcessMeta(t, workflow.workflowSteps)}{!projectOwned ? ` · ${team.name}` : null}</span>
              {projectOwned ? <span className="workflow-project-origin">
                <NavProjects size={ICON.sm} aria-hidden="true" />
                <span>{t("workflow.project_origin")} <a className="record-inline-action" href={projectUrl} title={t("workflow.open_project")}>{projectName ?? t("workflow.project_unavailable")}</a></span>
              </span> : null}
            </div>
            {canManage ? <div className="workflow-team-actions">
              <Button type="button" variant="ghost" size="dense" disabled={change.isPending || !workflow.enabled}
                onClick={() => apply(() => workflow.ownerTeamId ? setTeamDefaultWorkflow(team.id, isDefault ? "preset:build_review" : workflow.id) : setTeamProjectWorkflow(team.id, workflow.projectId!, isDefault ? null : workflow.id))}>{t(workflow.ownerTeamId ? (isDefault ? "workflow.clear_default" : "workflow.set_default") : (isDefault ? "workflow.clear_project_default" : "workflow.set_project_default"))}</Button>
              {!workflow.ownerTeamId ? <Button type="button" variant="ghost" size="dense" disabled={change.isPending || isDefault} onClick={() => apply(() => linkTeamWorkflow(team.id, workflow.id, false))}>{t("workflow.unassign")}</Button> : <Button type="button" variant="ghost" size="dense" onClick={() => setEditing({ workflow })}>{t("workflow.edit_steps")}</Button>}
            </div> : null}
          </div>
          <WorkflowStepSummary steps={workflow.workflowSteps} label={t("workflow.steps_of", { name: workflow.name })} agentName={id => agents.find(agent => agent.id === id)?.displayName ?? t("project.member_unavailable")} agentImage={id => agents.find(agent => agent.id === id)?.profileImageUrl} />
        </li>;
      })}
    </ul>
    <WorkflowEditorForPreview open={editing !== null} workflow={editing?.workflow ?? null} team={team} teams={[team]} agents={agents} onClose={() => setEditing(null)} />
    {canManage && !available.length && !loading && !loadFailed ? <p className="workflow-editor-note">{t("workflow.assign_hint")} <a className="record-inline-action" href="/projects">{t("workflow.open_projects")}</a></p> : null}
  </section>;
}
