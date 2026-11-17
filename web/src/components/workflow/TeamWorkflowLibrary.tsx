"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { linkTeamWorkflow, listProjects, setTeamProjectWorkflow, updateTeam } from "../../api";
import { PROJECTS_QUERY_KEY } from "../../hooks/useRelayData";
import { TEAMS_QUERY_KEY } from "../../hooks/useTeams";
import { useProjectWorkflows, useInvalidateWorkflows } from "../../hooks/useProjectWorkflows";
import { defaultWorkflowId, PREDEFINED_WORKFLOWS } from "../../lib/workflowSelection";
import type { AgentTeam, ProjectRecord, UserAgent } from "../../types";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PredefinedWorkflowIcon } from "./PredefinedWorkflowIcon";
import { WorkflowStepSummary } from "./WorkflowStepSummary";

/** Teams reference Project processes; definitions survive unassignment. */
export function TeamWorkflowLibrary({ team, agents, userId }: { team: AgentTeam; agents: UserAgent[]; userId?: string }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const invalidate = useInvalidateWorkflows();
  const [failure, setFailure] = useState<string | null>(null);
  const projectsQuery = useQuery({ queryKey: PROJECTS_QUERY_KEY,
    queryFn: async ({ signal }): Promise<ProjectRecord[]> => (await listProjects(signal)).projects ?? [], staleTime: 60_000 });
  const catalog = useProjectWorkflows(undefined, Boolean(userId));
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const canManage = Boolean(userId) && userId === team.ownerUserId;
  const custom = team.workflows ?? [];
  const available = (catalog.data?.workflows ?? []).filter(workflow => workflow.enabled
    && !custom.some(item => item.id === workflow.id)
    && projects.some(project => project.id === workflow.projectId && project.enabled && !project.archivedAt && project.computerId === team.computerId)
    && workflow.workflowSteps.every(step => team.memberAgentIds.includes(step.agentId)));
  const change = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: invalidate,
    onError: error => setFailure(error instanceof Error ? error.message : String(error)),
  });
  function apply(action: () => Promise<unknown>) {
    setFailure(null);
    change.mutate(action);
  }
  const badge = (label: string) => <span className="workflow-preview-kind">{label}</span>;

  return <section className="collab-style-section" aria-labelledby="team-workflows">
    <div className="workflow-library-head">
      <h2 id="team-workflows" className="workspace-dossier-section-title">{t("workflow.section_title")} <span className="tnum">{PREDEFINED_WORKFLOWS.length + custom.length}</span></h2>
      {canManage ? <Select value="" disabled={change.isPending || !available.length} onValueChange={id => { if (id) apply(() => linkTeamWorkflow(team.id, id)); }}>
        <SelectTrigger className="w-auto" aria-label={t("workflow.assign_workflow")}><SelectValue>{t("workflow.assign_workflow")}</SelectValue></SelectTrigger>
        <SelectContent>{available.map(workflow => <SelectItem key={workflow.id} value={workflow.id}>{workflow.name} · {projects.find(project => project.id === workflow.projectId)?.name}</SelectItem>)}</SelectContent>
      </Select> : null}
    </div>
    <p className="workflow-editor-note">{t("workflow.team_reference_hint")}</p>
    {failure ? <p role="alert" className="text-destructive">{failure}</p> : null}
    {projectsQuery.isPending || catalog.isPending ? <p aria-busy="true">{t("workflow.loading")}</p> : null}
    {projectsQuery.isError || catalog.isError ? <div role="alert"><p>{t("workflow.load_failed")}</p><Button type="button" variant="outline" size="dense" onClick={() => { void projectsQuery.refetch(); void catalog.refetch(); }}>{t("workspace.retry")}</Button></div> : null}
    <ul className="workflow-team-list">
      {PREDEFINED_WORKFLOWS.map(style => <li key={style} className="workflow-team-row" data-kind="predefined">
        <span className="workflow-library-main"><span className="workflow-team-row-name"><PredefinedWorkflowIcon style={style} /><span className="workflow-library-name">{t(`collab_style.${style}`)}</span>{badge(t("workflow.predefined"))}
          {defaultWorkflowId(team) === `preset:${style}` ? badge(t("workflow.default_badge")) : null}</span><span className="workflow-library-meta">{t(`collab_style.${style}_hint`)}</span></span>
        {canManage && defaultWorkflowId(team) !== `preset:${style}` ? <Button type="button" variant="ghost" size="dense" disabled={change.isPending}
          onClick={() => apply(async () => { await updateTeam(team.id, { defaultWorkflowId: `preset:${style}` }); await client.invalidateQueries({ queryKey: [TEAMS_QUERY_KEY] }); })}>{t("workflow.set_default")}</Button> : null}
      </li>)}
      {custom.map(workflow => {
        const project = projects.find(item => item.id === workflow.projectId);
        const isDefault = team.projectWorkflowDefaults?.[workflow.projectId] === workflow.id || team.defaultWorkflowId === workflow.id;
        const projectUrl = `/projects/${encodeURIComponent(workflow.projectId)}?tab=workflows`;
        return <li key={workflow.id} className="workflow-team-row" data-kind="steps">
          <div className="workflow-library-main">
            <span className="workflow-team-row-name"><span className="workflow-library-name">{workflow.name}</span>{badge(t("workflow.custom"))}{isDefault ? badge(t("workflow.project_default")) : null}{!workflow.enabled ? badge(t("teams.disabled")) : null}</span>
            <span className="workflow-library-meta">{t("workflow.custom_meta", { count: workflow.workflowSteps.length, project: project?.name ?? t("workflow.project_unavailable") })}</span>
            <details className="workflow-library-details"><summary>{t("workflow.view_steps")}</summary><WorkflowStepSummary steps={workflow.workflowSteps} agentName={id => agents.find(agent => agent.id === id)?.displayName ?? t("project.member_unavailable")} /></details>
          </div>
          <div className="workflow-team-actions">
            {canManage ? <>
              <Button type="button" variant="ghost" size="dense" disabled={change.isPending || !workflow.enabled}
                onClick={() => apply(() => setTeamProjectWorkflow(team.id, workflow.projectId, isDefault ? null : workflow.id))}>{t(isDefault ? "workflow.clear_project_default" : "workflow.set_project_default")}</Button>
              <Button type="button" variant="ghost" size="dense" disabled={change.isPending || isDefault} onClick={() => apply(() => linkTeamWorkflow(team.id, workflow.id, false))}>{t("workflow.unassign")}</Button>
            </> : null}
            <a className="record-inline-action" href={projectUrl}>{t("workflow.open_project")}</a>
          </div>
        </li>;
      })}
    </ul>
    {canManage && !available.length && !catalog.isPending && !catalog.isError ? <p className="workflow-editor-note">{t("workflow.assign_hint")} <a className="record-inline-action" href="/projects">{t("workflow.open_projects")}</a></p> : null}
  </section>;
}
