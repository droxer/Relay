"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listProjects, updateTeam } from "../../api";
import { PROJECTS_QUERY_KEY } from "../../hooks/useRelayData";
import { defaultWorkflowId, PREDEFINED_WORKFLOWS } from "../../lib/workflowSelection";
import { projectWorkflows, workflowProjects } from "../../lib/workflowTeamDraft";
import type { AgentTeam, ProjectRecord, TeamWorkflow, UserAgent } from "../../types";
import { Button } from "@/components/ui/button";
import { ActionAdd, ICON } from "../icons";
import { PredefinedWorkflowIcon } from "./PredefinedWorkflowIcon";
import { TEAMS_QUERY_KEY } from "../../hooks/useTeams";
import { useDialogs } from "@/components/ui/DialogProvider";
import { WorkflowStepSummary } from "./WorkflowStepSummary";
import { WorkflowEditor } from "./WorkflowEditor";

/** Every Workflow a Team can run, in one list: the predefined ones every
 *  Team has, then the custom ones made for it. New custom Workflows start
 *  here; each belongs to a Project, because its steps name Project Agents. */
export function TeamWorkflowLibrary({ team, agents, userId }: {
  team: AgentTeam;
  agents: UserAgent[];
  userId?: string;
}) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const client = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const defaultMutation = useMutation({
    mutationFn: (id: string) => updateTeam(team.id, { defaultWorkflowId: id }),
    onSuccess: () => client.invalidateQueries({ queryKey: [TEAMS_QUERY_KEY] }),
  });
  async function setDefault(id: string, project?: ProjectRecord) {
    if (defaultMutation.isPending) return;
    if (project && !(await confirm({
      title: t("workflow.set_default"),
      message: t("workflow.scoped_default_warning", { project: project.name }),
      confirmLabel: t("workflow.set_default"),
    }))) return;
    setFailure(null);
    try { await defaultMutation.mutateAsync(id); }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
  }
  const projectsQuery = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async ({ signal }): Promise<ProjectRecord[]> => (await listProjects(signal)).projects ?? [],
    staleTime: 60_000,
  });
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const eligible = useMemo(() => workflowProjects(team, projects, userId), [team, projects, userId]);
  // Kept after closing so the drawer animates out over what it showed.
  const [editing, setEditing] = useState<{ open: boolean; workflow: TeamWorkflow | null; project: ProjectRecord } | null>(null);
  const defaultId = defaultWorkflowId(team);
  const custom = team.workflows ?? projectWorkflows([team], team.projectId ?? "");
  const canManage = Boolean(userId) && userId === team.ownerUserId;
  const projectOf = (id: string) => projects.find(project => project.id === id);
  const tag = (label: string) => <span className="workflow-preview-kind">{label}</span>;

  return (
    <section className="collab-style-section" aria-labelledby="team-workflows">
      <div className="workflow-library-head">
        <h2 id="team-workflows" className="workspace-dossier-section-title">
          {t("workflow.section_title")} <span className="tnum">{PREDEFINED_WORKFLOWS.length + custom.length}</span>
        </h2>
        {eligible.length ? (
          <Button type="button" variant="outline" size="dense" onClick={() => setEditing({ open: true, workflow: null, project: eligible[0] })}>
            <ActionAdd size={ICON.sm} aria-hidden="true" />
            {t("workflow.create")}
          </Button>
        ) : null}
      </div>
      {failure ? <p role="alert" className="text-destructive">{failure}</p> : null}
      {projectsQuery.isPending ? <p aria-busy="true">{t("workflow.loading")}</p> : null}
      {projectsQuery.isError ? (
        <div role="alert">
          <p>{t("workflow.projects_load_failed")}</p>
          <Button type="button" variant="outline" size="dense" onClick={() => void projectsQuery.refetch()}>{t("workspace.retry")}</Button>
        </div>
      ) : null}
      <ul className="workflow-team-list">
        {PREDEFINED_WORKFLOWS.map(style => (
          <li key={style} className="workflow-team-row" data-kind="predefined">
            <span className="workflow-library-main">
              <span className="workflow-team-row-name">
                <PredefinedWorkflowIcon style={style} />
                <span className="workflow-library-name">{t(`collab_style.${style}`)}</span>
                {tag(t("workflow.predefined"))}
                {defaultId === `preset:${style}` ? tag(t("workflow.default_badge")) : null}
              </span>
              <span className="workflow-library-meta">{t(`collab_style.${style}_hint`)}</span>
            </span>
            {canManage && defaultId !== `preset:${style}` ? (
              <Button type="button" variant="ghost" size="dense" disabled={defaultMutation.isPending} onClick={() => void setDefault(`preset:${style}`)}>
                {t("workflow.set_default")}
              </Button>
            ) : null}
          </li>
        ))}
        {custom.map(workflow => {
          const project = projectOf(workflow.projectId);
          // Only the Project's owner manages its Workflows (the API agrees).
          const editable = Boolean(project && userId && project.ownerUserId === userId);
          return (
            <li key={workflow.id} className="workflow-team-row" data-kind="steps">
              <div className="workflow-library-main">
                <span className="workflow-team-row-name">
                  <span className="workflow-library-name">{workflow.name}</span>
                  {tag(t("workflow.custom"))}
                  {defaultId === workflow.id ? tag(t("workflow.default_badge")) : null}
                  {workflow.enabled ? null : tag(t("teams.disabled"))}
                </span>
                <span className="workflow-library-meta">
                  {t("workflow.custom_meta", {
                    count: workflow.workflowSteps.length,
                    project: project?.name ?? t("workflow.project_unavailable"),
                  })}
                </span>
                <details className="workflow-library-details">
                  <summary>{t("workflow.view_steps")}</summary>
                  <WorkflowStepSummary steps={workflow.workflowSteps}
                    agentName={id => agents.find(agent => agent.id === id)?.displayName ?? t("project.member_unavailable")} />
                </details>
              </div>
              <div className="workflow-team-actions">
                {canManage && project && workflow.enabled && defaultId !== workflow.id ? (
                  <Button type="button" variant="ghost" size="dense" disabled={defaultMutation.isPending} onClick={() => void setDefault(workflow.id, project)}>
                    {t("workflow.set_default")}
                  </Button>
                ) : null}
                {editable && project ? (
                  <Button type="button" variant="ghost" size="dense" onClick={() => setEditing({ open: true, workflow, project })}>
                    {t("workflow.edit")}
                  </Button>
                ) : null}
                <a className="record-inline-action" href={`/projects/${encodeURIComponent(workflow.projectId)}?tab=members#project-workflows-title`}>
                  {t("workflow.run_in_project")}
                </a>
              </div>
            </li>
          );
        })}
      </ul>
      {projectsQuery.isSuccess ? <p className="workflow-editor-note">
        {eligible.length ? t("workflow.library_hint") : t("workflow.create_needs_project")}
      </p> : null}
      {editing ? (
        <WorkflowEditor
          open={editing.open}
          project={editing.project}
          projects={editing.workflow ? undefined : eligible}
          workflow={editing.workflow}
          teams={[team]}
          agents={agents}
          onClose={() => setEditing({ ...editing, open: false })}
        />
      ) : null}
    </section>
  );
}
