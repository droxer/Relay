"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RelayApiError } from "../../api-client/client";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { agentRoleLabel, projectMemberRole } from "../../lib/agentRoleLabel";
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
  return <Drawer
    open={template !== null}
    onClose={onClose}
    kicker={project.name}
    title={t("workflow.preset_edit_title")}
    width="form"
    closeLabel={t("admin.v2.close_drawer")}
    bodyClassName="adm-drawer-body--column"
  >
    {template ? <EditorForm key={template} project={project} template={template} agents={agents} onClose={onClose} /> : null}
  </Drawer>;
}

function EditorForm({ project, template, agents, onClose }: Props & { template: Template }) {
  const { t } = useTranslation();
  const { updateProjectMutation } = useRelayMutations();
  const members = project.members.filter(member => member.enabled);
  const customised = Boolean(project.predefinedWorkflows?.[template]);
  const [expectedVersion] = useState(project.version);
  const [selected, setSelected] = useState(() => new Set(projectPresetParticipants(project, template)));
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
        expectedVersion,
        predefinedWorkflowChange: { workflowId: `preset:${template}`, agentIds },
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

  return <form className="workflow-editor" noValidate onSubmit={event => {
    event.preventDefault();
    if (picked.length) void save(picked.map(member => member.agentId));
  }}>
    <p className="workflow-editor-note">{t(`collab_style.${template}`)} · {t("workflow.preset_edit_hint")}</p>
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
            <span className="workflow-library-meta">{[
              agentRoleLabel(projectMemberRole(agent, member), t),
              isLocked ? t("workflow.preset_lead_locked") : undefined,
            ].filter(Boolean).join(" · ")}</span>
          </label>
        </li>;
      })}
    </ul>
    {!picked.length ? <p className="workflow-editor-note" role="alert">{t("workflow.project_roster_invalid")}</p> : null}
    {failure ? <p className="workflow-editor-note" role="alert">{failure}</p> : null}
    <div className="adm-form-actions">
      {customised ? <Button size="cta" type="button" variant="ghost" disabled={pending} onClick={() => void save(null)}>{t("workflow.preset_reset")}</Button> : null}
      <Button size="cta" type="button" variant="ghost" disabled={pending} onClick={onClose}>{t("dialog.cancel")}</Button>
      <Button size="cta" type="submit" loading={pending} disabled={!picked.length}>{t("workflow.save")}</Button>
    </div>
  </form>;
}
