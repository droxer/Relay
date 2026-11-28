"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Workflow, WorkflowPreview } from "../../types";
import {
  ActionApprove,
  ActionEdit,
  ActionToggle,
  AdminDelete,
  ArtifactPlan,
  ArtifactSummary,
  ComposerPermissionShield,
  ICON,
  MarkLead,
  NavBack,
  NavComputer,
  NavTeams,
  NavWorkflows,
} from "../icons";
import { MobileTopbarBack } from "../MobileTopbarSlot";
import { PageHeader } from "../PageHeader";
import { RelayEmptyState } from "../RelayEmptyState";
import { TonePill } from "../StatusPill";
import { ListSkeleton } from "../ListSkeleton";
import { Button } from "@/components/ui/button";
import { WorkflowAgentFace } from "./WorkflowAgentFace";
import { PredefinedWorkflowIcon } from "./PredefinedWorkflowIcon";

type WorkflowDetailProps = {
  workflow: WorkflowPreview;
  detail: Workflow | undefined;
  isPending: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  computerLabel: string;
  agentName: (agentId: string) => string;
  agentImage: (agentId: string) => string | null | undefined;
  busy: boolean;
  actionError: string | null;
  onBack: () => void;
  onEdit: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
};

export function WorkflowDetail({
  workflow,
  detail,
  isPending,
  isError,
  errorMessage,
  onRetry,
  computerLabel,
  agentName,
  agentImage,
  busy,
  actionError,
  onBack,
  onEdit,
  onToggleEnabled,
  onDelete,
}: WorkflowDetailProps) {
  const { t } = useTranslation();

  const isPredefined = workflow.kind === "predefined" || detail?.kind === "predefined";
  const steps = detail?.workflowSteps ?? workflow.workflowSteps;

  const gateCount = useMemo(() => {
    if (isPredefined) {
      return detail?.predefined?.humanApproval ? 1 : 0;
    }
    return steps.filter((step) => step.requiresApproval).length;
  }, [detail?.predefined?.humanApproval, isPredefined, steps]);

  const participantIds = useMemo(() => {
    if (isPredefined) {
      return detail?.predefined?.memberAgentIds ?? [];
    }
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const step of steps) {
      if (step.agentId && !seen.has(step.agentId)) {
        seen.add(step.agentId);
        ordered.push(step.agentId);
      }
    }
    return ordered;
  }, [detail?.predefined?.memberAgentIds, isPredefined, steps]);

  return (
    <>
      <MobileTopbarBack
        label={t("workflows.title")}
        onBack={onBack}
        fallback={(
          <Button
            type="button"
            variant="ghost"
            className="teams-mobile-back"
            onClick={onBack}
          >
            <NavBack size={ICON.sm} aria-hidden="true" />
            {t("workflows.title")}
          </Button>
        )}
      />
      <div className="workspace-page workflow-detail-page" data-enabled={workflow.enabled ? "true" : "false"}>
        <PageHeader
          title={(
            <span className="workspace-header-title">
              <span className="workspace-header-mark" aria-hidden="true">
                {detail?.kind === "predefined" && detail.predefined ? (
                  <PredefinedWorkflowIcon style={detail.predefined.template} />
                ) : (
                  <NavWorkflows size={ICON.sm} />
                )}
              </span>
              <span className="workflow-detail-title-text">{workflow.name}</span>
            </span>
          )}
          topbarTitle={workflow.name}
          facts={(
            <TonePill
              tone={workflow.enabled ? "good" : "neutral"}
              label={t(workflow.enabled ? "teams.enabled" : "teams.disabled")}
            />
          )}
          titleAs="h2"
          titleVariant="record"
          actions={(
            <div className="workflow-team-actions">
              <TonePill
                className="workflow-detail-mobile-status"
                tone={workflow.enabled ? "good" : "neutral"}
                label={t(workflow.enabled ? "teams.enabled" : "teams.disabled")}
              />
              {!isPredefined ? (
                <Button type="button" variant="default" size="dense" disabled={busy} onClick={onEdit}>
                  <ActionEdit size={ICON.sm} aria-hidden="true" />
                  {t("workflow.edit_steps")}
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="dense" disabled={busy} onClick={onToggleEnabled}>
                <ActionToggle size={ICON.sm} aria-hidden="true" />
                {t(workflow.enabled ? "workflows.disable" : "workflows.enable")}
              </Button>
              <Button type="button" variant="ghost" size="dense" disabled={busy} onClick={onDelete}>
                <AdminDelete size={ICON.sm} aria-hidden="true" />
                {t("workflow.delete")}
              </Button>
            </div>
          )}
        />

        <div className="workflow-detail-body">
          <div className="workflow-detail-stack">
            {actionError ? <p role="alert" className="text-destructive">{actionError}</p> : null}

            {/* One hairline-divided summary strip: computer, kind, steps/agents, approval gates. */}
            <dl className="workflow-detail-summary" aria-label={workflow.name}>
              <div className="workflow-detail-stat">
                <dt className="workflow-detail-stat-label">{t("workflows.computer")}</dt>
                <dd className="workflow-detail-stat-value">
                  <NavComputer size={ICON.sm} className="workflow-detail-stat-icon" aria-hidden="true" />
                  <span className="workflow-detail-stat-text">{computerLabel || "—"}</span>
                </dd>
              </div>
              <div className="workflow-detail-stat">
                <dt className="workflow-detail-stat-label">{t("workflow.assigned_workflow")}</dt>
                <dd className="workflow-detail-stat-value">
                  {detail?.kind === "predefined" && detail.predefined ? (
                    <PredefinedWorkflowIcon style={detail.predefined.template} className="workflow-detail-stat-icon" />
                  ) : (
                    <NavWorkflows size={ICON.sm} className="workflow-detail-stat-icon" aria-hidden="true" />
                  )}
                  <span className="workflow-detail-stat-text">
                    {isPredefined ? t("workflow.predefined") : t("workflow.custom")}
                  </span>
                </dd>
              </div>
              <div className="workflow-detail-stat">
                <dt className="workflow-detail-stat-label">
                  {isPredefined ? t("workflow.preset_participants") : t("workflow.steps")}
                </dt>
                <dd className="workflow-detail-stat-value">
                  <span className="workflow-detail-stat-num tnum">
                    {isPredefined ? participantIds.length : steps.length}
                  </span>
                </dd>
              </div>
              <div className="workflow-detail-stat" data-gated={gateCount > 0 ? "true" : "false"}>
                <dt className="workflow-detail-stat-label">{t("workflow.gate_badge")}</dt>
                <dd className="workflow-detail-stat-value">
                  {gateCount > 0 ? (
                    <ComposerPermissionShield size={ICON.sm} className="workflow-detail-gate-icon" aria-hidden="true" />
                  ) : null}
                  <span className={gateCount > 0 ? "workflow-detail-stat-num workflow-detail-stat-num--gated tnum" : "workflow-detail-stat-num workflow-detail-stat-num--zero tnum"}>
                    {gateCount}
                  </span>
                </dd>
              </div>
            </dl>

            {isPending ? (
              <ListSkeleton label={t("workflow.loading")} />
            ) : isError ? (
              <RelayEmptyState
                feature="workflows"
                title={t("workflow.load_failed")}
                body={errorMessage}
                actions={(
                  <Button type="button" variant="outline" onClick={onRetry}>
                    {t("workspace.retry")}
                  </Button>
                )}
              />
            ) : detail?.kind === "predefined" && detail.predefined ? (
              <section
                className="workflow-detail-card workflow-detail-preset"
                data-gate={detail.predefined.humanApproval ? "true" : undefined}
                aria-label={t("workflow.predefined")}
              >
                <div className="workflow-detail-card-head">
                  <div className="workflow-detail-card-title-group">
                    <span className="workspace-header-mark" aria-hidden="true">
                      <PredefinedWorkflowIcon style={detail.predefined.template} />
                    </span>
                    <h3 className="workflow-detail-step-name">
                      {t(`collab_style.${detail.predefined.template}`)}
                    </h3>
                    {detail.predefined.humanApproval ? (
                      <span className="workflow-step-gate workflow-detail-gate-pill">
                        <ComposerPermissionShield size={ICON.xs} aria-hidden="true" />
                        {t("workflow.gate_badge")}
                      </span>
                    ) : null}
                  </div>
                </div>
                <p className="workflow-detail-instructions-body">
                  {t(`collab_style.${detail.predefined.template}_hint`)}
                </p>

                <div className="workflow-detail-section">
                  <div className="workflow-detail-field-head">
                    <NavTeams size={ICON.xs} aria-hidden="true" />
                    <span>{t("workflow.preset_participants")}</span>
                    <span className="workflow-detail-section-count tnum">
                      {detail.predefined.memberAgentIds.length}
                    </span>
                  </div>
                  <ul className="workflow-detail-participants" aria-label={t("workflow.preset_participants")}>
                    {detail.predefined.memberAgentIds.map((memberId) => {
                      const isLead = memberId === detail.predefined?.leadAgentId;
                      return (
                        <li key={memberId} className="workflow-detail-participant" data-lead={isLead ? "true" : undefined}>
                          <WorkflowAgentFace imageUrl={agentImage(memberId)} />
                          <span className="workflow-detail-participant-name">{agentName(memberId)}</span>
                          {isLead ? (
                            <span className="workflow-detail-lead-badge">
                              <MarkLead size={ICON.xs} aria-hidden="true" />
                              {t("collab_style.turn_lead")}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {detail.predefined.acceptanceCriteria?.length ? (
                  <div className="workflow-detail-section">
                    <div className="workflow-detail-field-head">
                      <ArtifactPlan size={ICON.xs} aria-hidden="true" />
                      <span>{t("workflow.step_criteria")}</span>
                      <span className="workflow-detail-section-count tnum">
                        {detail.predefined.acceptanceCriteria.length}
                      </span>
                    </div>
                    <ul className="workflow-detail-checklist">
                      {detail.predefined.acceptanceCriteria.map((criterion, idx) => (
                        <li key={idx} className="workflow-detail-check-item">
                          <ActionApprove size={ICON.xs} className="workflow-detail-check-icon" aria-hidden="true" />
                          <span>{criterion}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : detail ? (
              <section className="workflow-detail-pipeline" aria-label={t("workflow.steps")}>
                <div className="workflow-detail-section-head">
                  <h3 className="workflow-detail-section-title">
                    {t("workflow.steps")}
                    <span className="workflow-detail-section-count tnum">{detail.workflowSteps.length}</span>
                  </h3>
                </div>
                <ol className="workflow-detail-rail" aria-label={t("workflow.steps")}>
                  {detail.workflowSteps.map((step, index) => (
                    <li
                      key={step.id}
                      id={`workflow-step-${step.id}`}
                      className="workflow-detail-step"
                      data-gate={step.requiresApproval ? "true" : undefined}
                    >
                      <div className="workflow-detail-spine" aria-hidden="true">
                        <span className="workflow-detail-node tnum">{index + 1}</span>
                      </div>
                      <article className="workflow-detail-card" data-gate={step.requiresApproval ? "true" : undefined}>
                        <div className="workflow-detail-card-head">
                          <div className="workflow-detail-card-title-group">
                            <h4 className="workflow-detail-step-name">{step.name}</h4>
                            {step.requiresApproval ? (
                              <span className="workflow-step-gate workflow-detail-gate-pill">
                                <ComposerPermissionShield size={ICON.xs} aria-hidden="true" />
                                {t("workflow.gate_badge")}
                              </span>
                            ) : null}
                          </div>
                          <span className="workflow-detail-owner">
                            <WorkflowAgentFace imageUrl={agentImage(step.agentId)} />
                            <span className="workflow-detail-owner-name">{agentName(step.agentId)}</span>
                          </span>
                        </div>

                        {step.instructions ? (
                          <div className="workflow-detail-section">
                            <div className="workflow-detail-field-head">
                              <ArtifactSummary size={ICON.xs} aria-hidden="true" />
                              <span>{t("workflow.step_instructions")}</span>
                            </div>
                            <p className="workflow-detail-instructions-body">{step.instructions}</p>
                          </div>
                        ) : null}

                        {step.acceptanceCriteria.length > 0 ? (
                          <div className="workflow-detail-section">
                            <div className="workflow-detail-field-head">
                              <ArtifactPlan size={ICON.xs} aria-hidden="true" />
                              <span>{t("workflow.step_criteria")}</span>
                              <span className="workflow-detail-section-count tnum">
                                {step.acceptanceCriteria.length}
                              </span>
                            </div>
                            <ul className="workflow-detail-checklist">
                              {step.acceptanceCriteria.map((criterion, idx) => (
                                <li key={idx} className="workflow-detail-check-item">
                                  <ActionApprove size={ICON.xs} className="workflow-detail-check-icon" aria-hidden="true" />
                                  <span>{criterion}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </article>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
