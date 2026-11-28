"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { RelayApiError } from "../../api-client/client";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { projectMemberRole } from "../../lib/agentRoleLabel";
import { AgentRoleMeta } from "../RoleLevelBadge";
import { projectPresetParticipants, type PREDEFINED_WORKFLOWS } from "../../lib/workflowSelection";
import type { ProjectListItem, UserAgent } from "../../types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Drawer } from "@/components/ui/Drawer";
import { WorkflowAgentFace } from "./WorkflowAgentFace";

type Template = typeof PREDEFINED_WORKFLOWS[number];

type Props = {
  project: ProjectListItem;
  template: Template | null;
  agents: UserAgent[];
  onClose: () => void;
};

/** Chooses which enabled Project Agents take part in one Predefined Workflow.
 *  The Lead always joins Lead-led. */
export function PredefinedWorkflowEditor({ project, template, agents, onClose }: Props) {
  const { t } = useTranslation();
  if (!template) {
    return (
      <Drawer
        open={false}
        onClose={onClose}
        kicker={project.name}
        title={t("workflow.preset_edit_title")}
        width="form"
      >
        {null}
      </Drawer>
    );
  }
  return <EditorForm key={template} project={project} template={template} agents={agents} onClose={onClose} />;
}

function EditorForm({ project, template, agents, onClose }: Props & { template: Template }) {
  const { t } = useTranslation();
  const formId = useId();
  const { updateProjectMutation } = useRelayMutations();
  const members = project.members.filter(member => member.enabled);
  const customised = project.predefinedWorkflows?.[template]?.agentIds != null;
  const [initial] = useState(() => ({
    version: project.version,
    requireIndependentReview: project.predefinedWorkflows?.build_review?.requireIndependentReview === true,
  }));
  const [selected, setSelected] = useState(() => new Set(projectPresetParticipants(project, template)));
  const [requireIndependentReview, setRequireIndependentReview] = useState(initial.requireIndependentReview);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const locked = (agentId: string) => template === "lead_led" && agentId === project.leadAgentId;
  const picked = members.filter(member => selected.has(member.agentId) || locked(member.agentId));

  async function save(agentIds: string[] | null) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await updateProjectMutation.mutateAsync({ projectId: project.id, input: {
        expectedVersion: initial.version,
        predefinedWorkflowChange: template === "build_review"
          ? {
            workflowId: "preset:build_review",
            agentIds,
            ...(requireIndependentReview !== initial.requireIndependentReview ? { requireIndependentReview } : {}),
          }
          : { workflowId: "preset:lead_led", agentIds },
      } });
      onClose();
    } catch (error) {
      setFailure(error instanceof RelayApiError && error.code === "project_version_conflict"
        ? t("workflow.preset_conflict")
        : error instanceof Error ? error.message : t("errors.save_project"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      kicker={project.name}
      title={t("workflow.preset_edit_title")}
      subtitle={t(`collab_style.${template}`)}
      width="form"
      footer={
        <>
          {customised ? (
            <Button size="cta" type="button" variant="ghost" className="adm-form-actions-leading" disabled={pending} onClick={() => void save(null)}>
              {t("workflow.preset_reset")}
            </Button>
          ) : null}
          <Button size="cta" type="button" variant="ghost" disabled={pending} onClick={onClose}>{t("dialog.cancel")}</Button>
          <Button size="cta" type="submit" form={formId} loading={pending} disabled={!picked.length}>{t("workflow.save")}</Button>
        </>
      }
    >
      <form id={formId} className="workflow-editor" noValidate onSubmit={event => {
        event.preventDefault();
        if (picked.length) void save(!customised && picked.length === members.length
          ? null : picked.map(member => member.agentId));
      }}>
        {template === "build_review" ? (
          <label className="workflow-preset-choice">
            <Checkbox checked={requireIndependentReview} disabled={pending}
              onCheckedChange={checked => setRequireIndependentReview(checked === true)} />
            <span>{t("workflow.preset_require_independent_review")}</span>
          </label>
        ) : null}
        <p className="workflow-editor-note">{t("workflow.preset_edit_hint")}</p>
        <ul className="workflow-preset-choices" aria-label={t("workflow.preset_participants")}>
          {members.map(member => {
            const agent = agents.find(item => item.id === member.agentId);
            const name = agent?.displayName ?? t("project.member_unavailable");
            const isLocked = locked(member.agentId);
            return <li key={member.agentId}>
              <label className="workflow-preset-choice">
                <Checkbox checked={isLocked || selected.has(member.agentId)} disabled={pending || isLocked}
                  onCheckedChange={checked => setSelected(current => {
                    const next = new Set(current);
                    if (checked) next.add(member.agentId); else next.delete(member.agentId);
                    return next;
                  })} />
                <WorkflowAgentFace imageUrl={agent?.profileImageUrl} />
                <span className="workflow-preset-choice-name">{name}</span>
                <span className="workflow-library-meta">
                  <AgentRoleMeta identity={projectMemberRole(agent, member)} className="" />
                  {isLocked ? (
                    <>
                      {projectMemberRole(agent, member)?.defaultRole ? <span aria-hidden="true"> · </span> : null}
                      <span>{t("workflow.preset_lead_locked")}</span>
                    </>
                  ) : null}
                </span>
              </label>
            </li>;
          })}
        </ul>
        {!picked.length ? <p className="workflow-editor-note" role="alert">{t("workflow.project_roster_invalid")}</p> : null}
        {failure ? <p className="workflow-editor-note" role="alert">{failure}</p> : null}
      </form>
    </Drawer>
  );
}
