"use client";

import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { AgentTeam, CollaborationStyle } from "../../types";
import { approvalSlotIndex, previewGaps, previewSlots, type SlotMember } from "../../lib/collaborationStyle";
import { predefinedStyle } from "../../lib/workflowSelection";
import { ActionRetry, DisclosureChevron } from "../icons";
import { PredefinedWorkflowIcon } from "./PredefinedWorkflowIcon";
import { WorkflowStepSummary } from "./WorkflowStepSummary";
import { useWorkflowName } from "./WorkflowSelect";

/** One statement of a Team's Workflow, read or edited: its name and kind,
 *  what it means, then who does what — role slots for a predefined Workflow,
 *  numbered steps for a custom one. Both answer the same question, so they
 *  share one frame. */
export function TeamWorkflowPreview({ team, workflowId, members, leadId, approval, nameOf }: {
  team: AgentTeam;
  workflowId: string;
  members: SlotMember[];
  leadId?: string;
  approval?: boolean;
  nameOf: (agentId: string) => string;
}) {
  const { t } = useTranslation();
  const workflowName = useWorkflowName(team);
  const style = predefinedStyle(workflowId);
  const custom = style ? undefined : team.workflows?.find(item => item.id === workflowId);
  return <div className="workflow-preview" data-kind={style ? "predefined" : "steps"} data-style={style}>
    <div className="workflow-preview-head">
      <span className="workflow-preview-name">
        {style ? <PredefinedWorkflowIcon style={style} /> : null}
        {workflowName(workflowId)}
      </span>
      <span className="workflow-preview-kind">{t(style ? "workflow.predefined" : "workflow.custom")}</span>
    </div>
    {style ? <>
      <p className="workflow-preview-hint">{t(`collab_style.${style}_hint`)}</p>
      <RoleSlots members={members} leadId={leadId} style={style} approval={approval} nameOf={nameOf} />
    </> : custom ? <WorkflowStepSummary steps={custom.workflowSteps} agentName={nameOf} label={t("workflow.steps_of", { name: custom.name })} />
      : null}
  </div>;
}

const initialOf = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? "?";

/** Who fills each role slot of a predefined Workflow, in run order. */
function RoleSlots({ members, leadId, style, nameOf, approval }: {
  members: SlotMember[]; leadId?: string; style: CollaborationStyle; nameOf: (id: string) => string;
  /** The team's person approves the work before the final step. */
  approval?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const preview = previewSlots(members, leadId, style);
  const approvalAt = approvalSlotIndex(preview, approval);
  const gaps = previewGaps(members, preview);
  const skippedNames = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(gaps.skipped.map(nameOf));
  // Lead-led closes on the lead again; name that step for what it does.
  // A pipeline step is "a member"; its role is what tells the steps apart.
  const roleOf = (id: string) => members.find((member) => member.id === id)?.role;
  const slotLabel = (slot: string, memberId: string, index: number) => {
    const role = roleOf(memberId);
    if (slot === "member" && role) return t(`team_work.role_${role}`, { defaultValue: t("collab_style.slot_member") });
    return t(`collab_style.slot_${slot === "lead" && index > 0 ? "lead_summary" : slot}`);
  };
  const builder = preview.slots.find((slot) => slot.slot === "builder");
  const reviewer = preview.slots.find((slot) => slot.slot === "reviewer");
  return <div className="collab-style-preview" data-style={preview.style} aria-live="polite">
    <ol className="collab-style-sequence">
      {preview.slots.map((slot, index) => <Fragment key={`${slot.slot}-${index}`}>
      {index === approvalAt ? <li data-slot="approval">
        <DisclosureChevron aria-hidden="true" className="collab-style-arrow" />
        <span className="collab-style-step">
          <span className="collab-style-step-avatar" aria-hidden="true">{initialOf(t("collab_style.slot_approval_name"))}</span>
          <span className="collab-style-step-text">
            <span className="collab-style-step-role">{t("collab_style.slot_approval")}<span className="sr-only">: </span></span>
            <span className="collab-style-step-name">{t("collab_style.slot_approval_name")}</span>
          </span>
        </span>
      </li> : null}
      <li data-slot={slot.slot}>
        {index > 0 ? <DisclosureChevron aria-hidden="true" className="collab-style-arrow" /> : null}
        <span className="collab-style-step">
          <span className="collab-style-step-avatar" aria-hidden="true">{initialOf(nameOf(slot.memberId))}</span>
          <span className="collab-style-step-text">
            <span className="collab-style-step-role">{slotLabel(slot.slot, slot.memberId, index)}<span className="sr-only">: </span></span>
            <span className="collab-style-step-name">{nameOf(slot.memberId)}</span>
          </span>
        </span>
      </li>
      </Fragment>)}
    </ol>
    {builder && reviewer ? <p className="collab-style-loop">
      <ActionRetry aria-hidden="true" className="size-4 shrink-0" />
      <span>{t("collab_style.loop_until_approved", { builder: nameOf(builder.memberId), reviewer: nameOf(reviewer.memberId) })}</span>
    </p> : null}
    {approvalAt !== null ? <p className="collab-style-loop">
      {t("collab_style.approval_loop", { next: nameOf(preview.slots[approvalAt].memberId) })}
    </p> : null}
    {gaps.specialistBuilder ? <p className="collab-style-loop">{t("collab_style.specialist_builds", { name: nameOf(gaps.specialistBuilder) })}</p> : null}
    {gaps.skipped.length ? <p className="collab-style-loop">{t("collab_style.members_skipped", { count: gaps.skipped.length, names: skippedNames })}</p>
      : preview.fallbackFrom ? <p className="collab-style-loop">{t("collab_style.fallback_solo")}</p> : null}
  </div>;
}
